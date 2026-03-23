import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Termos de Uso | IbateXas",
  description: "Termos de uso, política de devolução, entrega e cancelamento de reservas",
  openGraph: {
    title: "Termos de Uso | IbateXas",
    description: "Termos de uso, política de devolução, entrega e cancelamento de reservas",
  },
}

export default function TermosPage() {
  return (
    <div className="min-h-screen bg-smoke-50 py-12">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 space-y-12">
        <h1 className="text-3xl font-display text-charcoal-900">Termos de Uso</h1>

        {/* Termos de Compra */}
        <section>
          <h2 className="text-xl font-display text-charcoal-900 mb-4">Termos de Compra</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-smoke-500">
            <li>Todos os preços são exibidos em Reais (R$) e incluem impostos</li>
            <li>Pedidos são confirmados após aprovação do pagamento</li>
            <li>A disponibilidade dos produtos está sujeita ao estoque</li>
            <li>Pedidos de comida quente estão sujeitos ao horário de funcionamento</li>
            <li>Pedidos de produtos congelados e mercadorias estão disponíveis 24h</li>
          </ul>
        </section>

        {/* Política de Devolução e Reembolso */}
        <section>
          <h2 className="text-xl font-display text-charcoal-900 mb-4">Política de Devolução e Reembolso</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-smoke-500">
            <li>Comida quente: não aceita devoluções após entrega, exceto em caso de erro no pedido</li>
            <li>Produtos congelados: devolução em até 7 dias se embalagem lacrada e armazenamento adequado</li>
            <li>Mercadorias: devolução em até 30 dias em condição original com etiqueta</li>
            <li>Reembolsos processados em até 10 dias úteis pelo mesmo método de pagamento</li>
            <li>Para solicitar devolução, entre em contato via WhatsApp</li>
          </ul>
        </section>

        {/* Política de Entrega */}
        <section>
          <h2 className="text-xl font-display text-charcoal-900 mb-4">Política de Entrega</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-smoke-500">
            <li>Entrega disponível nas zonas de entrega definidas (verificação por CEP)</li>
            <li>Taxas de entrega variam por região</li>
            <li>Tempo estimado informado no checkout (inclui preparo + deslocamento)</li>
            <li>Opção de retirada no local disponível (agendamento de horário)</li>
            <li>Pedidos para consumo no local (dine-in) não incluem entrega</li>
          </ul>
        </section>

        {/* Política de Cancelamento de Reservas */}
        <section>
          <h2 className="text-xl font-display text-charcoal-900 mb-4">Política de Cancelamento de Reservas</h2>
          <ul className="list-disc pl-5 space-y-2 text-sm text-smoke-500">
            <li>Cancelamento gratuito até 2 horas antes do horário reservado</li>
            <li>No-show: após 15 minutos de tolerância, a reserva é marcada como não comparecimento</li>
            <li>Clientes na lista de espera são notificados automaticamente via WhatsApp quando uma vaga abre</li>
            <li>O tempo de resposta da lista de espera é de 30 minutos após notificação</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
