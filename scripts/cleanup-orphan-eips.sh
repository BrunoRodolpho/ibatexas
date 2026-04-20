#!/usr/bin/env bash
# Release orphan Elastic IPs attached to the ALB.
#
# Context: the ibatexas-dev ALB was provisioned without subnet_mappings (its
# terraform only sets `subnets = ...`), but 6 EIPs were manually associated to
# the ALB's ENIs at some point — likely via the AWS Console or an earlier
# terraform run. These EIPs bill $0.005/hour each ($21.90/mo for 6) even while
# the ALB itself normally auto-assigns public IPs for free.
#
# When this script runs:
#   1. Lists all EIPs associated to ENIs whose description starts with "ELB app/ibatexas-"
#   2. Asks for confirmation
#   3. Disassociates each EIP (ALB auto-assigns a new non-Elastic public IP)
#   4. Releases each EIP (stops billing)
#
# Risk: DNS points at the ALB's DNS name (alias record), not at specific IPs, so
# clients re-resolve and reach the new auto-assigned IPs. Brief (~0 to 2 min)
# DNS propagation window possible for in-flight connections.
#
# Usage:
#   ./scripts/cleanup-orphan-eips.sh             # dry-run prompt, then run
#   ./scripts/cleanup-orphan-eips.sh --yes       # skip prompt, run directly

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ALB_PREFIX="${ALB_PREFIX:-ELB app/ibatexas-}"
AUTO_YES="${1:-}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Orphan EIP cleanup (region=$REGION)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Find ALB ENIs
ALB_ENIS=$(aws ec2 describe-network-interfaces \
  --region "$REGION" \
  --filters "Name=description,Values=${ALB_PREFIX}*" \
  --query 'NetworkInterfaces[*].NetworkInterfaceId' \
  --output text)

if [[ -z "$ALB_ENIS" ]]; then
  echo "  No ALB ENIs found matching '${ALB_PREFIX}*'. Nothing to do."
  exit 0
fi

# For each ENI, find associated EIP (if any)
declare -a TARGETS=()
for eni in $ALB_ENIS; do
  ALLOC=$(aws ec2 describe-addresses \
    --region "$REGION" \
    --filters "Name=network-interface-id,Values=$eni" \
    --query 'Addresses[0].[AllocationId,PublicIp,AssociationId]' \
    --output text 2>/dev/null)
  if [[ "$ALLOC" != "None" && "$ALLOC" != "None	None	None" && -n "$ALLOC" ]]; then
    TARGETS+=("$eni|$ALLOC")
    echo "  $eni → EIP $(echo "$ALLOC" | awk '{print $2}')  (alloc $(echo "$ALLOC" | awk '{print $1}'))"
  fi
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "  No EIPs currently attached to ALB ENIs. Nothing to release."
  exit 0
fi

MONTHLY=$(echo "${#TARGETS[@]} * 3.65" | bc 2>/dev/null || echo "$((${#TARGETS[@]} * 365 / 100))")
echo ""
echo "  Found ${#TARGETS[@]} EIP(s). Estimated monthly savings: ~\$${MONTHLY}"
echo ""

if [[ "$AUTO_YES" != "--yes" ]]; then
  read -r -p "  Proceed with disassociate + release? [y/N] " CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "  Aborted."
    exit 0
  fi
fi

echo ""
for target in "${TARGETS[@]}"; do
  ENI="${target%%|*}"
  REST="${target#*|}"
  ALLOC_ID=$(echo "$REST" | awk '{print $1}')
  ASSOC_ID=$(echo "$REST" | awk '{print $3}')

  echo "  Disassociating $ASSOC_ID from $ENI..."
  aws ec2 disassociate-address \
    --region "$REGION" \
    --association-id "$ASSOC_ID"

  echo "  Releasing $ALLOC_ID..."
  aws ec2 release-address \
    --region "$REGION" \
    --allocation-id "$ALLOC_ID"
done

echo ""
echo "  ✅  Released ${#TARGETS[@]} EIP(s)."
echo ""
echo "  ALB will auto-assign non-Elastic public IPs within seconds. DNS already"
echo "  points at the ALB's DNS name, so clients re-resolve to the new IPs"
echo "  automatically."
echo ""
