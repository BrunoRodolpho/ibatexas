'use client'

import { useConsentStore } from '@/domains/consent'
import { Button } from '@/components/atoms'

export default function PrivacidadePage() {
  const reset = useConsentStore((s) => s.reset)

  return (
    <div className="max-w-3xl mx-auto px-4 py-16 lg:py-24">
      <h1 className="font-display text-3xl font-bold text-charcoal-900 mb-8">
        Política de Privacidade
      </h1>

      {/* Dados Coletados */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-charcoal-900 mb-3">Dados Coletados</h2>
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-smoke-500">
          <li>Nome completo e telefone celular (cadastro via WhatsApp)</li>
          <li>Endereço de entrega (quando fornecido)</li>
          <li>Histórico de pedidos e preferências alimentares</li>
          <li>Dados de navegação via cookies (com consentimento)</li>
          <li>Avaliações e comentários sobre produtos</li>
        </ul>
      </section>

      {/* Uso dos Dados */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-charcoal-900 mb-3">Uso dos Dados</h2>
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-smoke-500">
          <li>Processamento e entrega de pedidos</li>
          <li>Personalização de recomendações e experiência</li>
          <li>Comunicação via WhatsApp sobre pedidos e reservas</li>
          <li>Análise de uso do site para melhoria do serviço</li>
          <li>Emissão de documentos fiscais (NF-e)</li>
        </ul>
      </section>

      {/* Retenção de Dados */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-charcoal-900 mb-3">Retenção de Dados</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="font-medium text-charcoal-900 min-w-[180px]">Dados de pedidos</dt>
            <dd className="text-smoke-500">5 anos (obrigação fiscal)</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-charcoal-900 min-w-[180px]">Perfil do cliente</dt>
            <dd className="text-smoke-500">Enquanto conta ativa + 30 dias após solicitação de exclusão</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-charcoal-900 min-w-[180px]">Dados de navegação</dt>
            <dd className="text-smoke-500">90 dias</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-charcoal-900 min-w-[180px]">Sessões</dt>
            <dd className="text-smoke-500">48 horas</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-charcoal-900 min-w-[180px]">Avaliações</dt>
            <dd className="text-smoke-500">Mantidas indefinidamente (anonimizadas após exclusão de conta)</dd>
          </div>
        </dl>
      </section>

      {/* Seus Direitos (LGPD Art. 18) */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-charcoal-900 mb-3">Seus Direitos</h2>
        <p className="text-sm text-smoke-500 mb-3">
          De acordo com a Lei Geral de Proteção de Dados (LGPD, Art. 18), você tem direito a:
        </p>
        <ol className="list-decimal pl-5 space-y-1.5 text-sm text-smoke-500">
          <li>Confirmação da existência de tratamento</li>
          <li>Acesso aos dados</li>
          <li>Correção de dados incompletos ou desatualizados</li>
          <li>Anonimização, bloqueio ou eliminação de dados desnecessários</li>
          <li>Portabilidade dos dados</li>
          <li>Eliminação dos dados pessoais</li>
          <li>Informação sobre compartilhamento de dados</li>
          <li>Informação sobre a possibilidade de não fornecer consentimento</li>
          <li>Revogação do consentimento</li>
        </ol>
      </section>

      {/* Contato */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-charcoal-900 mb-3">Contato</h2>
        <p className="text-sm text-smoke-500 mb-3">
          Para exercer seus direitos ou esclarecer dúvidas sobre o tratamento de seus dados, entre em contato:
        </p>
        <ul className="space-y-1.5 text-sm text-smoke-500">
          <li>
            WhatsApp:{' '}
            <a
              href={process.env.NEXT_PUBLIC_WHATSAPP_URL || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-600 hover:text-brand-700 underline"
            >
              {process.env.NEXT_PUBLIC_PHONE || 'Nosso WhatsApp'}
            </a>
          </li>
          <li>
            Email:{' '}
            <a
              href="mailto:privacidade@ibatexas.com"
              className="text-brand-600 hover:text-brand-700 underline"
            >
              privacidade@ibatexas.com
            </a>
          </li>
        </ul>
      </section>

      {/* Preferências de Cookies */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-charcoal-900 mb-3">Preferências de Cookies</h2>
        <p className="text-sm text-smoke-500 mb-4">
          Você pode redefinir suas preferências de cookies a qualquer momento.
        </p>
        <Button onClick={reset}>
          Redefinir preferências de cookies
        </Button>
      </section>
    </div>
  )
}
