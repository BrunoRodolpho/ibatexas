'use client'

import { useTranslations } from 'next-intl'
import { Modal } from './Modal'
import { Text } from '../atoms'

interface SizeGuideProps {
  readonly isOpen: boolean
  readonly onClose: () => void
}

export const SizeGuide = ({ isOpen, onClose }: SizeGuideProps) => {
  const t = useTranslations()

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('shop.size_guide.title')}
      size="lg"
    >
      <div className="p-6">
        <Text className="text-smoke-400 mb-6">
          Medidas em centímetros. As medidas podem variar 2cm para mais ou menos.
        </Text>
        
        {/* Size Chart Table */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse border border-smoke-200">
            <thead>
              <tr className="bg-smoke-100">
                <th scope="col" className="border border-smoke-200 px-4 py-3 text-left font-medium">
                  Tamanho
                </th>
                <th scope="col" className="border border-smoke-200 px-4 py-3 text-center font-medium">
                  {t('shop.size_guide.chest')}
                </th>
                <th scope="col" className="border border-smoke-200 px-4 py-3 text-center font-medium">
                  {t('shop.size_guide.length')}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-smoke-200 px-4 py-3 font-medium">P</td>
                <td className="border border-smoke-200 px-4 py-3 text-center">51 cm</td>
                <td className="border border-smoke-200 px-4 py-3 text-center">69 cm</td>
              </tr>
              <tr className="bg-smoke-50">
                <td className="border border-smoke-200 px-4 py-3 font-medium">M</td>
                <td className="border border-smoke-200 px-4 py-3 text-center">55 cm</td>
                <td className="border border-smoke-200 px-4 py-3 text-center">72 cm</td>
              </tr>
              <tr>
                <td className="border border-smoke-200 px-4 py-3 font-medium">G</td>
                <td className="border border-smoke-200 px-4 py-3 text-center">59 cm</td>
                <td className="border border-smoke-200 px-4 py-3 text-center">75 cm</td>
              </tr>
              <tr className="bg-smoke-50">
                <td className="border border-smoke-200 px-4 py-3 font-medium">GG</td>
                <td className="border border-smoke-200 px-4 py-3 text-center">63 cm</td>
                <td className="border border-smoke-200 px-4 py-3 text-center">78 cm</td>
              </tr>
            </tbody>
          </table>
        </div>
        
        {/* Measurement Instructions */}
        <div className="mt-6 space-y-4">
          <div>
            <Text className="font-medium text-charcoal-900 mb-2">
              Como medir:
            </Text>
            <ul className="space-y-2 text-sm text-smoke-400">
              <li>
                <strong>Largura do Peito:</strong> Meça de uma axila até a outra, na parte mais larga do peito
              </li>
              <li>
                <strong>Comprimento:</strong> Meça do ombro até a barra da camiseta
              </li>
            </ul>
          </div>
          
          <div className="bg-brand-50 p-4 rounded-lg">
            <Text variant="small" className="text-brand-800">
              💡 <strong>Dica:</strong> Se você está entre dois tamanhos, recomendamos escolher o maior para maior conforto.
            </Text>
          </div>
        </div>
      </div>
    </Modal>
  )
}