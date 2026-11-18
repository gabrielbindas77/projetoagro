import { useState, type FormEvent } from 'react';
import { X, CheckCircle2, AlertCircle, Lock } from 'lucide-react';
import { apiFetch, ApiError, setAuthToken } from '../lib/api.ts';
import { maskCPF, maskPhone, validateCPFClient } from '../lib/format.ts';
import type { User } from '../types.ts';

interface AuthModalProps {
  initialMode: 'login' | 'register' | 'recovery' | 'verify';
  user: User | null;
  onClose: () => void;
  onAuthenticated: (user: User) => void;
}

export function AuthModal({ initialMode, user, onClose, onAuthenticated }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'recovery' | 'verify'>(initialMode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Login fields (exclusively CPF + Password)
  const [loginCpf, setLoginCpf] = useState('');
  const [loginSenha, setLoginSenha] = useState('');

  // Register fields
  const [nome, setNome] = useState('');
  const [regCpf, setRegCpf] = useState('');
  const [email, setEmail] = useState('');
  const [telefone, setTelefone] = useState('');
  const [regSenha, setRegSenha] = useState('');
  const [confirmSenha, setConfirmSenha] = useState('');

  // Verification codes
  const [emailCode, setEmailCode] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [emailVerifiedLocal, setEmailVerifiedLocal] = useState(Boolean(user?.email_verificado));
  const [phoneVerifiedLocal, setPhoneVerifiedLocal] = useState(Boolean(user?.telefone_verificado));
  const [verificationInfo, setVerificationInfo] = useState<{ email?: string; telefone?: string; identidade?: string } | null>(null);

  // Password recovery
  const [recCpf, setRecCpf] = useState('');
  const [recStep, setRecStep] = useState<'request' | 'reset'>('request');
  const [recCode, setRecCode] = useState('');
  const [recNewPass, setRecNewPass] = useState('');

  const passwordRules = [
    { label: 'Mínimo 8 caracteres', ok: regSenha.length >= 8 },
    { label: 'Letra maiúscula e minúscula', ok: /[A-Z]/.test(regSenha) && /[a-z]/.test(regSenha) },
    { label: 'Pelo menos 1 número', ok: /[0-9]/.test(regSenha) },
    { label: 'Caractere especial (!@#$...)', ok: /[^A-Za-z0-9]/.test(regSenha) },
  ];

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!validateCPFClient(loginCpf)) {
      setError('CPF inválido. Verifique os dígitos informados.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<{ user: User; token?: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ cpf: loginCpf, senha: loginSenha }),
      });
      if (data.token) setAuthToken(data.token);
      onAuthenticated(data.user);
      onClose();
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Falha ao autenticar.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!validateCPFClient(regCpf)) {
      setError('CPF inválido. Verifique os 11 dígitos.');
      return;
    }
    if (regSenha !== confirmSenha) {
      setError('A senha e a confirmação de senha não conferem.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<{
        token?: string;
        user: User;
        verificacao: { email: { note: string }; telefone: { note: string }; identidade: string };
      }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          nome_completo: nome,
          cpf: regCpf,
          email,
          telefone,
          senha: regSenha,
          confirmacao_senha: confirmSenha,
        }),
      });
      if (data.token) setAuthToken(data.token);
      onAuthenticated(data.user);
      setVerificationInfo({
        email: data.verificacao.email.note,
        telefone: data.verificacao.telefone.note,
        identidade: data.verificacao.identidade,
      });
      setMode('verify');
      setNotice('Conta criada com sucesso. Confirme seu e-mail e telefone abaixo.');
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Erro ao criar conta.');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(tipo: 'EMAIL' | 'TELEFONE') {
    setError(null);
    setNotice(null);
    const codigo = tipo === 'EMAIL' ? emailCode : phoneCode;
    setLoading(true);
    try {
      await apiFetch('/api/auth/verification/confirm', {
        method: 'POST',
        body: JSON.stringify({ tipo, codigo }),
      });
      if (tipo === 'EMAIL') setEmailVerifiedLocal(true);
      else setPhoneVerifiedLocal(true);
      const me = await apiFetch<{ user: User | null }>('/api/auth/me');
      if (me.user) onAuthenticated(me.user);
      setNotice(tipo === 'EMAIL' ? 'E-mail confirmado com sucesso.' : 'Telefone confirmado com sucesso.');
    } catch (err: any) {
      setError(err?.message || 'Código inválido.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResendCode(tipo: 'EMAIL' | 'TELEFONE') {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ note: string }>('/api/auth/verification/send', {
        method: 'POST',
        body: JSON.stringify({ tipo }),
      });
      setNotice(res.note);
    } catch (err: any) {
      setError(err?.message || 'Erro ao reenviar código.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRecoveryRequest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ note: string }>('/api/auth/password-recovery/request', {
        method: 'POST',
        body: JSON.stringify({ cpf: recCpf }),
      });
      setNotice(res.note);
      setRecStep('reset');
    } catch (err: any) {
      setError(err?.message || 'Erro ao solicitar recuperação.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRecoveryReset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await apiFetch('/api/auth/password-recovery/reset', {
        method: 'POST',
        body: JSON.stringify({ cpf: recCpf, codigo: recCode, nova_senha: recNewPass }),
      });
      setNotice('Senha redefinida com sucesso. Entre com seu CPF e nova senha.');
      setMode('login');
      setLoginCpf(recCpf);
    } catch (err: any) {
      setError(err?.message || 'Não foi possível redefinir a senha.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl max-w-md w-full border border-zinc-200 shadow-xl overflow-hidden my-auto">
        <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between bg-[#FAFBF9]">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-[#143824]" />
            <h2 className="text-base font-semibold text-zinc-900">
              {mode === 'login' && 'Entrar na Agro Marconato'}
              {mode === 'register' && 'Criar conta de cliente'}
              {mode === 'recovery' && 'Recuperar senha'}
              {mode === 'verify' && 'Confirmar e-mail e telefone'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 rounded-md hover:bg-zinc-100 cursor-pointer"
            aria-label="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {mode !== 'verify' && (
          <div className="flex border-b border-zinc-200 px-6 pt-3 gap-6 text-sm">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`pb-2.5 font-medium border-b-2 transition-colors cursor-pointer ${
                mode === 'login' ? 'border-[#143824] text-[#143824]' : 'border-transparent text-zinc-500 hover:text-zinc-900'
              }`}
            >
              Entrar
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setError(null);
              }}
              className={`pb-2.5 font-medium border-b-2 transition-colors cursor-pointer ${
                mode === 'register' ? 'border-[#143824] text-[#143824]' : 'border-transparent text-zinc-500 hover:text-zinc-900'
              }`}
            >
              Criar conta
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('recovery');
                setError(null);
              }}
              className={`pb-2.5 font-medium border-b-2 transition-colors cursor-pointer ${
                mode === 'recovery' ? 'border-[#143824] text-[#143824]' : 'border-transparent text-zinc-500 hover:text-zinc-900'
              }`}
            >
              Recuperar senha
            </button>
          </div>
        )}

        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="mb-4 p-3 rounded-lg bg-[#e9f2ec] border border-[#143824]/20 text-sm text-[#143824] flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}

          {mode === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">CPF</label>
                <input
                  type="text"
                  required
                  inputMode="numeric"
                  placeholder="000.000.000-00"
                  value={loginCpf}
                  onChange={(e) => setLoginCpf(maskCPF(e.target.value))}
                  className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824] font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Senha</label>
                <input
                  type="password"
                  required
                  placeholder="Digite sua senha"
                  value={loginSenha}
                  onChange={(e) => setLoginSenha(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 bg-[#143824] hover:bg-[#1f5135] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                {loading ? 'Entrando...' : 'Entrar com CPF'}
              </button>
              <p className="text-xs text-zinc-500 text-center">
                Acesso exclusivo por CPF e senha. Protegido contra tentativas repetidas.
              </p>
            </form>
          )}

          {mode === 'register' && (
            <form onSubmit={handleRegister} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Nome completo</label>
                <input
                  type="text"
                  required
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  placeholder="João da Silva"
                  className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">CPF</label>
                  <input
                    type="text"
                    required
                    inputMode="numeric"
                    value={regCpf}
                    onChange={(e) => setRegCpf(maskCPF(e.target.value))}
                    placeholder="000.000.000-00"
                    className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824] font-mono-tabular"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Telefone (WhatsApp/SMS)</label>
                  <input
                    type="text"
                    required
                    inputMode="numeric"
                    value={telefone}
                    onChange={(e) => setTelefone(maskPhone(e.target.value))}
                    placeholder="(11) 99999-9999"
                    className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824] font-mono-tabular"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">E-mail</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="cliente@exemplo.com.br"
                  className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Senha</label>
                  <input
                    type="password"
                    required
                    value={regSenha}
                    onChange={(e) => setRegSenha(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Confirmar senha</label>
                  <input
                    type="password"
                    required
                    value={confirmSenha}
                    onChange={(e) => setConfirmSenha(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-xs text-zinc-600 pt-1">
                {passwordRules.map((r) => (
                  <div key={r.label} className={`flex items-center gap-1.5 ${r.ok ? 'text-[#143824] font-medium' : 'text-zinc-500'}`}>
                    <span>{r.ok ? '✓' : '·'}</span>
                    <span>{r.label}</span>
                  </div>
                ))}
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 bg-[#143824] hover:bg-[#1f5135] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                {loading ? 'Cadastrando...' : 'Criar conta'}
              </button>
            </form>
          )}

          {mode === 'recovery' && (
            <div className="space-y-4">
              {recStep === 'request' ? (
                <form onSubmit={handleRecoveryRequest} className="space-y-4">
                  <p className="text-sm text-zinc-600">
                    Informe seu CPF cadastrado para enviar um código de recuperação ao seu e-mail.
                  </p>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1">CPF</label>
                    <input
                      type="text"
                      required
                      value={recCpf}
                      onChange={(e) => setRecCpf(maskCPF(e.target.value))}
                      placeholder="000.000.000-00"
                      className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2.5 px-4 bg-[#143824] hover:bg-[#1f5135] text-white text-sm font-medium rounded-lg cursor-pointer"
                  >
                    {loading ? 'Enviando...' : 'Solicitar código'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleRecoveryReset} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1">Código de 6 dígitos</label>
                    <input
                      type="text"
                      required
                      maxLength={6}
                      value={recCode}
                      onChange={(e) => setRecCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1">Nova senha forte</label>
                    <input
                      type="password"
                      required
                      value={recNewPass}
                      onChange={(e) => setRecNewPass(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2.5 px-4 bg-[#143824] hover:bg-[#1f5135] text-white text-sm font-medium rounded-lg cursor-pointer"
                  >
                    {loading ? 'Redefinindo...' : 'Redefinir senha'}
                  </button>
                </form>
              )}
            </div>
          )}

          {mode === 'verify' && (
            <div className="space-y-5">
              {verificationInfo?.identidade && (
                <p className="text-xs text-zinc-600 bg-[#F5F2EB] p-3 rounded-lg">
                  {verificationInfo.identidade}
                </p>
              )}

              <div className="space-y-2 pb-4 border-b border-zinc-200">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-900">Confirmação de E-mail</span>
                  <span className="text-xs font-medium text-zinc-600">
                    {emailVerifiedLocal ? 'Confirmado' : 'Pendente'}
                  </span>
                </div>
                {verificationInfo?.email && (
                  <p className="text-xs text-zinc-500">{verificationInfo.email}</p>
                )}
                {!emailVerifiedLocal && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      maxLength={6}
                      placeholder="Código 6 dígitos"
                      value={emailCode}
                      onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                      className="flex-1 px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                    />
                    <button
                      type="button"
                      onClick={() => handleVerifyCode('EMAIL')}
                      disabled={loading}
                      className="px-3.5 py-2 bg-[#143824] text-white text-xs font-medium rounded-lg cursor-pointer"
                    >
                      Validar
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResendCode('EMAIL')}
                      disabled={loading}
                      className="px-3 py-2 border border-zinc-300 text-zinc-700 text-xs font-medium rounded-lg cursor-pointer"
                    >
                      Reenviar
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-900">Confirmação de Telefone (SMS / WhatsApp)</span>
                  <span className="text-xs font-medium text-zinc-600">
                    {phoneVerifiedLocal ? 'Confirmado' : 'Pendente'}
                  </span>
                </div>
                {verificationInfo?.telefone && (
                  <p className="text-xs text-zinc-500">{verificationInfo.telefone}</p>
                )}
                {!phoneVerifiedLocal && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      maxLength={6}
                      placeholder="Código 6 dígitos"
                      value={phoneCode}
                      onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ''))}
                      className="flex-1 px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                    />
                    <button
                      type="button"
                      onClick={() => handleVerifyCode('TELEFONE')}
                      disabled={loading}
                      className="px-3.5 py-2 bg-[#143824] text-white text-xs font-medium rounded-lg cursor-pointer"
                    >
                      Validar
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResendCode('TELEFONE')}
                      disabled={loading}
                      className="px-3 py-2 border border-zinc-300 text-zinc-700 text-xs font-medium rounded-lg cursor-pointer"
                    >
                      Reenviar
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={onClose}
                className="w-full py-2.5 px-4 border border-zinc-300 hover:bg-zinc-50 text-zinc-800 text-sm font-medium rounded-lg cursor-pointer"
              >
                Continuar para a loja
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
