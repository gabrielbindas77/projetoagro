import crypto from 'crypto';
import nodemailer from 'nodemailer';

export function normalizeText(input: string): string {
  return (input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function cleanDigits(input: string): string {
  return (input || '').replace(/\D/g, '');
}

export function isValidCPF(rawCpf: string): boolean {
  const cpf = cleanDigits(rawCpf);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(cpf.charAt(i)) * (10 - i);
  }
  let remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== Number(cpf.charAt(9))) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += Number(cpf.charAt(i)) * (11 - i);
  }
  remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== Number(cpf.charAt(10))) return false;

  return true;
}

export function formatCPF(rawCpf: string): string {
  const d = cleanDigits(rawCpf);
  if (d.length !== 11) return rawCpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
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

export function normalizeBrazilPhone(rawPhone: string): string {
  let digits = cleanDigits(rawPhone);
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  return digits;
}

export function isValidBrazilPhone(rawPhone: string): boolean {
  const digits = normalizeBrazilPhone(rawPhone);
  if (digits.length !== 10 && digits.length !== 11) return false;
  const ddd = digits.slice(0, 2);
  if (!VALID_BR_DDDS.has(ddd)) return false;
  const local = digits.slice(2);
  if (/^(\d)\1+$/.test(local)) return false;
  if (digits.length === 11) {
    if (digits.charAt(2) !== '9') return false;
    if (/^90+$/.test(local) || local === '912345678') return false;
  }
  return true;
}

export async function verifyPhoneNumberWithApi(rawPhone: string): Promise<{
  valid: boolean;
  active: boolean;
  normalized: string;
  e164: string;
  checkedExternal: boolean;
  provider: string;
  message: string;
}> {
  const digits = normalizeBrazilPhone(rawPhone);
  const e164 = `+55${digits}`;

  if (!isValidBrazilPhone(digits)) {
    return {
      valid: false,
      active: false,
      normalized: digits,
      e164,
      checkedExternal: false,
      provider: 'anatel_ddd',
      message: 'Número de telefone/WhatsApp inválido. Informe DDD válido + número ativo com 9 dígitos para celular.',
    };
  }

  // 1. WhatsApp Business / Evolution / Z-API check if configured
  const waCheckUrl = process.env.WHATSAPP_CHECK_API_URL;
  const waCheckToken = process.env.WHATSAPP_CHECK_API_TOKEN;
  if (waCheckUrl) {
    try {
      const resp = await fetch(waCheckUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(waCheckToken ? { Authorization: `Bearer ${waCheckToken}`, 'Client-Token': waCheckToken } : {}),
        },
        body: JSON.stringify({ phone: `55${digits}`, numbers: [`55${digits}`] }),
      });
      if (resp.ok) {
        const data: any = await resp.json().catch(() => ({}));
        const exists = Boolean(
          data?.exists ??
            data?.isRegistered ??
            data?.onWhatsApp ??
            (Array.isArray(data) ? data[0]?.exists : undefined)
        );
        return {
          valid: exists,
          active: exists,
          normalized: digits,
          e164,
          checkedExternal: true,
          provider: 'whatsapp_api',
          message: exists
            ? 'WhatsApp ativo e confirmado.'
            : 'Este número não possui WhatsApp ativo. Verifique o número informado.',
        };
      }
    } catch {
      // fall through to carrier lookup if configured
    }
  }

  // 2. Twilio Lookup v2 if configured
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  if (twilioSid && twilioToken) {
    try {
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      const resp = await fetch(
        `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}`,
        {
          headers: { Authorization: `Basic ${auth}` },
        }
      );
      if (resp.ok) {
        const data: any = await resp.json().catch(() => ({}));
        const ok = Boolean(data?.valid);
        return {
          valid: ok,
          active: ok,
          normalized: digits,
          e164,
          checkedExternal: true,
          provider: 'twilio_lookup',
          message: ok
            ? 'Telefone ativo confirmado pela operadora.'
            : 'O número de telefone informado não foi reconhecido como ativo.',
        };
      }
    } catch {
      // fall through
    }
  }

  // 3. AbstractAPI Phone Validation if configured
  const abstractKey = process.env.ABSTRACT_PHONE_API_KEY;
  if (abstractKey) {
    try {
      const resp = await fetch(
        `https://phonevalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(abstractKey)}&phone=55${digits}`
      );
      if (resp.ok) {
        const data: any = await resp.json().catch(() => ({}));
        const ok = Boolean(data?.valid);
        return {
          valid: ok,
          active: ok,
          normalized: digits,
          e164,
          checkedExternal: true,
          provider: 'abstract_phone',
          message: ok
            ? 'Telefone validado e ativo.'
            : 'Número de telefone não encontrado ou inativo.',
        };
      }
    } catch {
      // fall through
    }
  }

  // 4. Numverify if configured
  const numverifyKey = process.env.NUMVERIFY_API_KEY;
  if (numverifyKey) {
    try {
      const resp = await fetch(
        `https://apilayer.net/api/validate?access_key=${encodeURIComponent(numverifyKey)}&number=55${digits}&format=1`
      );
      if (resp.ok) {
        const data: any = await resp.json().catch(() => ({}));
        const ok = Boolean(data?.valid);
        return {
          valid: ok,
          active: ok,
          normalized: digits,
          e164,
          checkedExternal: true,
          provider: 'numverify',
          message: ok ? 'Telefone ativo confirmado.' : 'Número de telefone inválido ou inativo.',
        };
      }
    } catch {
      // fall through
    }
  }

  return {
    valid: true,
    active: true,
    normalized: digits,
    e164,
    checkedExternal: false,
    provider: 'anatel_ddd',
    message: 'DDD e formato de WhatsApp/telefone verificados.',
  };
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((email || '').trim());
}

export function validatePasswordStrength(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!password || password.length < 6) {
    errors.push('A senha deve ter no mínimo 6 caracteres.');
  }
  return { valid: errors.length === 0, errors };
}

export function generateNumericCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export async function verifyExternalCpfIdentity(
  cpf: string,
  nomeCompleto: string
): Promise<{ checked: boolean; verified: boolean; providerMessage: string }> {
  const apiUrl = process.env.CPF_VERIFICATION_API_URL;
  const apiKey = process.env.CPF_VERIFICATION_API_KEY;
  if (!apiUrl || !apiKey) {
    return {
      checked: false,
      verified: false,
      providerMessage: 'Serviço externo de verificação cadastral de CPF não configurado no ambiente (validação matemática de dígitos verificadores aplicada).',
    };
  }
  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ cpf: cleanDigits(cpf), nome: nomeCompleto }),
    });
    if (!resp.ok) {
      return {
        checked: true,
        verified: false,
        providerMessage: `Falha na consulta ao provedor externo (${resp.status}).`,
      };
    }
    const data: any = await resp.json();
    const ok = Boolean(data?.valid || data?.regular || data?.match);
    return {
      checked: true,
      verified: ok,
      providerMessage: ok ? 'Titularidade confirmada pelo provedor cadastral.' : 'Dados não conferem na base cadastral.',
    };
  } catch (err: any) {
    return {
      checked: true,
      verified: false,
      providerMessage: `Erro de comunicação com provedor cadastral: ${err?.message || 'desconhecido'}`,
    };
  }
}

export async function dispatchEmailCode(
  toEmail: string,
  code: string,
  purpose: 'verificacao' | 'recuperacao'
): Promise<{ sent: boolean; channel: string; note: string }> {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true';
  const from = process.env.SMTP_FROM || 'Agro Marconato <noreply@agromarconato.com.br>';

  if (!host || !user || !pass) {
    console.info(`[EMAIL-DEV] Código para ${toEmail} (${purpose}): ${code}`);
    return {
      sent: false,
      channel: 'unconfigured',
      note: 'SMTP não configurado (configure SMTP_HOST, SMTP_USER e SMTP_PASS nas variáveis de ambiente para disparo real de e-mails).',
    };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const subject =
    purpose === 'verificacao'
      ? 'Agro Marconato — Código de confirmação de e-mail'
      : 'Agro Marconato — Código de recuperação de senha';

  await transporter.sendMail({
    from,
    to: toEmail,
    subject,
    text: `Olá! Seu código de confirmação na Agro Marconato Agropecuária é: ${code}. Ele expira em 15 minutos.`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e4e4e7;border-radius:8px;">
      <h2 style="color:#143824;margin-top:0;">Agro Marconato Agropecuária</h2>
      <p>Use o código abaixo para concluir sua solicitação:</p>
      <div style="font-size:28px;font-weight:700;letter-spacing:4px;color:#143824;padding:16px;background:#f5f2eb;text-align:center;border-radius:6px;">${code}</div>
      <p style="font-size:13px;color:#525866;margin-top:16px;">Válido por 15 minutos. Caso não tenha solicitado, ignore esta mensagem.</p>
    </div>`,
  });

  return {
    sent: true,
    channel: 'smtp',
    note: 'Código enviado para o seu e-mail.',
  };
}

export async function dispatchPhoneCode(
  rawPhone: string,
  code: string
): Promise<{ sent: boolean; channel: string; note: string }> {
  const digits = cleanDigits(rawPhone);
  const e164 = digits.startsWith('55') ? `+${digits}` : `+55${digits}`;

  const waToken = process.env.WHATSAPP_CLOUD_TOKEN;
  const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (waToken && waPhoneId) {
    try {
      const resp = await fetch(`https://graph.facebook.com/v20.0/${waPhoneId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${waToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: e164.replace('+', ''),
          type: 'text',
          text: { body: `Agro Marconato: seu código de confirmação é ${code}. Válido por 15 minutos.` },
        }),
      });
      if (resp.ok) {
        return { sent: true, channel: 'whatsapp', note: 'Código enviado via WhatsApp.' };
      }
    } catch (err) {
      console.error('Erro WhatsApp Cloud API:', err);
    }
  }

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;

  if (twilioSid && twilioToken && twilioFrom) {
    try {
      const params = new URLSearchParams({
        To: e164,
        From: twilioFrom,
        Body: `Agro Marconato: seu código de verificação é ${code}. Expira em 15 minutos.`,
      });
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        }
      );
      if (resp.ok) {
        return { sent: true, channel: 'sms', note: 'Código enviado via SMS.' };
      }
    } catch (err) {
      console.error('Erro Twilio SMS:', err);
    }
  }

  console.info(`[PHONE-DEV] Código SMS/WhatsApp para ${e164}: ${code}`);
  return {
    sent: false,
    channel: 'unconfigured',
    note: 'Provedor de SMS/WhatsApp não configurado (configure WHATSAPP_CLOUD_TOKEN ou TWILIO_ACCOUNT_SID no ambiente para envio real).',
  };
}

export function verifyMercadoPagoWebhookSignature(params: {
  xSignature?: string;
  xRequestId?: string;
  dataId?: string;
  secret?: string;
}): boolean {
  const { xSignature, xRequestId, dataId, secret } = params;
  if (!secret) return false;
  if (!xSignature || !dataId) return false;

  const parts = xSignature.split(',');
  let ts = '';
  let hash = '';
  for (const part of parts) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k === 'ts') ts = v;
    if (k === 'v1') hash = v;
  }
  if (!ts || !hash) return false;

  const manifest = `id:${dataId};request-id:${xRequestId || ''};ts:${ts};`;
  const computed = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
