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

const VALID_BR_DDDS = new Set([
  '11','12','13','14','15','16','17','18','19',
  '21','22','24','27','28',
  '31','32','33','34','35','37','38',
  '41','42','43','44','45','46','47','48','49',
  '51','53','54','55',
  '61','62','63','64','65','66','67','68','69',
  '71','73','74','75','77','79',
  '81','82','83','84','85','86','87','88','89',
  '91','92','93','94','95','96','97','98','99',
]);

export function normalizeBrazilPhoneClient(rawPhone: string): string {
  let digits = (rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  return digits;
}

export function isValidBrazilPhoneClient(rawPhone: string): boolean {
  const digits = normalizeBrazilPhoneClient(rawPhone);
  if (digits.length !== 10 && digits.length !== 11) return false;
  if (!VALID_BR_DDDS.has(digits.slice(0, 2))) return false;
  const local = digits.slice(2);
  if (/^(\d)\1+$/.test(local)) return false;
  if (digits.length === 11) {
    if (digits.charAt(2) !== '9') return false;
    if (/^90+$/.test(local) || local === '912345678') return false;
  }
  return true;
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
