import { MessageCircle } from 'lucide-react';

interface WhatsAppButtonProps {
  whatsappNumber: string;
}

export function WhatsAppButton({ whatsappNumber }: WhatsAppButtonProps) {
  const digits = (whatsappNumber || '5511999999999').replace(/\D/g, '');
  const text = encodeURIComponent(
    'Olá! Gostaria de falar com a equipe da Agro Marconato Agropecuária.'
  );
  const href = `https://wa.me/${digits}?text=${text}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Atendimento pelo WhatsApp"
      className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 px-4 py-3 bg-[#143824] hover:bg-[#1f5135] text-white text-sm font-semibold rounded-full shadow-lg transition-transform hover:-translate-y-0.5"
    >
      <MessageCircle className="w-5 h-5" />
      <span className="hidden sm:inline">WhatsApp</span>
    </a>
  );
}
