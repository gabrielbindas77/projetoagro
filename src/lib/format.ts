export function formatBRL(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

export function formatWeight(kg: number, precisao = 3): string {
  return Number(kg).toLocaleString('pt-BR', {
    minimumFractionDigits: precisao,
    maximumFractionDigits: precisao,
  });
}

export function maskCPF(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  return d
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

export function maskPhone(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 10) {
    return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2');
  }
  return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2');
}

export function maskCEP(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 8);
  return d.replace(/(\d{5})(\d)/, '$1-$2');
}

export function validateCPFClient(rawCpf: string): boolean {
  const cpf = rawCpf.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== Number(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  return rem === Number(cpf[10]);
}

export function formatDateTimeBR(iso: string): string {
  if (!iso) return '';
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  CONFIRMADO: 'Confirmado',
  EM_PREPARACAO: 'Em preparação',
  SAIU_PARA_ENTREGA: 'Saiu para entrega',
  ENTREGUE: 'Entregue',
  CANCELADO: 'Cancelado',
};

export const FINANCE_STATUS_LABEL: Record<string, string> = {
  AGUARDANDO_PAGAMENTO: 'Aguardando pagamento',
  PAGO: 'Pago',
  RECUSADO: 'Recusado',
  CANCELADO: 'Cancelado',
  ESTORNADO: 'Estornado',
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  PIX: 'PIX',
  CARTAO_CREDITO: 'Cartão de crédito',
  DINHEIRO_NA_ENTREGA: 'Dinheiro na entrega',
};
