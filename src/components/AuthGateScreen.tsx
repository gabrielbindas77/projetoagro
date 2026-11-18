import { useState, type FormEvent } from 'react';
import { Lock, ShieldCheck, CheckCircle2, AlertCircle } from 'lucide-react';
import { apiFetch, ApiError, setAuthToken } from '../lib/api.ts';
import { maskCPF, maskPhone, validateCPFClient } from '../lib/format.ts';
import type { User } from '../types.ts';

interface AuthGateScreenProps {
  isAdminRoute: boolean;
  onNavigate: (path: string) => void;
  onAuthenticated: (user: User) => void;
}

export function AuthGateScreen({ isAdminRoute, onNavigate, onAuthenticated }: AuthGateScreenProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'recovery'>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Login (exclusively CPF + Password)
  const [loginCpf, setLoginCpf] = useState('');
  const [loginSenha, setLoginSenha] = useState('');

  // Register (Clients only)
  const [nome, setNome] = useState('');
  const [regCpf, setRegCpf] = useState('');
  const [email, setEmail] = useState('');
  const [telefone, setTelefone] = useState('');
  const [regSenha, setRegSenha] = useState('');
  const [confirmSenha, setConfirmSenha] = useState('');

  // Password recovery
  const [recCpf, setRecCpf] = useState('');
  const [recStep, setRecStep] = useState<'request' | 'reset'>('request');
  const [recCode, setRecCode] = useState('');
  const [recNewPass, setRecNewPass] = useState('');

  const passwordRules = [
    { label: 'Mínimo 8 caracteres', ok: regSenha.length >= 8 },
    { label: 'Maiúscula e minúscula', ok: /[A-Z]/.test(regSenha) && /[a-z]/.test(regSenha) },
    { label: 'Pelo menos 1 número', ok: /[0-9]/.test(regSenha) },
    { label: 'Caractere especial', ok: /[^A-Za-z0-9]/.test(regSenha) },
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
      if (isAdminRoute && data.user.papel !== 'ADMIN') {
        await apiFetch('/api/auth/logout', { method: 'POST' });
        setAuthToken(null);
        setError('Esta conta é de cliente. Entre com uma conta de administrador para acessar /admin.');
        return;
      }
      if (data.token) setAuthToken(data.token);
      onAuthenticated(data.user);
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Falha ao entrar.');
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
      const data = await apiFetch<{ user: User; token?: string }>('/api/auth/register', {
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
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Erro ao criar conta.');
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
    <div className="min-h-screen bg-[#FAFBF9] flex flex-col justify-between">
      {/* Simple Top Bar */}
      <header className="bg-white border-b border-zinc-200 px-6 h-16 flex items-center justify-between">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
          }}
          className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-[#143824]"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 20C4 11.5 10.5 5 19 4C18 12.5 11.5 19 4 20Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path d="M4 20L13.5 10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span className="font-display">Agro Marconato</span>
        </a>

        <div className="flex items-center gap-4 text-xs font-medium">
          {isAdminRoute ? (
            <button
              type="button"
              onClick={() => onNavigate('/')}
              className="text-zinc-600 hover:text-[#143824] cursor-pointer"
            >
              Voltar ao acesso de clientes
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('/admin')}
              className="inline-flex items-center gap-1.5 text-zinc-700 hover:text-[#143824] cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4 text-[#143824]" />
              <span>Painel Administrativo (/admin)</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Auth Gate Grid */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
        <div className="max-w-5xl w-full bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm grid grid-cols-1 lg:grid-cols-12">
          {/* Left: Brand Visual */}
          <div className="lg:col-span-5 relative bg-[#143824] text-white flex flex-col justify-between p-8 min-h-[260px]">
            <img
              src="/src/assets/images/hero_agro_marconato_1794877320649.jpg"
              alt="Agro Marconato Agropecuária"
              referrerPolicy="no-referrer"
              className="absolute inset-0 w-full h-full object-cover opacity-30"
            />
            <div className="relative z-10 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#d4e7da]">
                Agro Marconato Agropecuária
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold leading-tight [text-wrap:balance]">
                {isAdminRoute
                  ? 'Administração da Loja'
                  : 'Entre ou cadastre-se para acessar o catálogo'}
              </h1>
              <p className="text-sm text-zinc-200 leading-relaxed">
                {isAdminRoute
                  ? 'Área restrita para cadastro real de produtos, upload de imagens, controle de estoque, pedidos e atendimento.'
                  : 'Identifique-se com seu CPF para visualizar produtos, comprar por unidade, quilo ou valor, acompanhar entregas e falar com nossa equipe.'}
              </p>
            </div>
            <div className="relative z-10 pt-6 text-xs text-zinc-300">
              Acesso protegido por autenticação e validação de CPF.
            </div>
          </div>

          {/* Right: Auth Forms */}
          <div className="lg:col-span-7 p-6 sm:p-10">
            {!isAdminRoute && (
              <div className="flex border-b border-zinc-200 mb-6 gap-6 text-sm">
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                  }}
                  className={`pb-3 font-semibold border-b-2 transition-colors cursor-pointer ${
                    mode === 'login'
                      ? 'border-[#143824] text-[#143824]'
                      : 'border-transparent text-zinc-500 hover:text-zinc-900'
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
                  className={`pb-3 font-semibold border-b-2 transition-colors cursor-pointer ${
                    mode === 'register'
                      ? 'border-[#143824] text-[#143824]'
                      : 'border-transparent text-zinc-500 hover:text-zinc-900'
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
                  className={`pb-3 font-semibold border-b-2 transition-colors cursor-pointer ${
                    mode === 'recovery'
                      ? 'border-[#143824] text-[#143824]'
                      : 'border-transparent text-zinc-500 hover:text-zinc-900'
                  }`}
                >
                  Recuperar senha
                </button>
              </div>
            )}

            {isAdminRoute && (
              <div className="mb-6 pb-4 border-b border-zinc-200 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#143824]" />
                <div>
                  <h2 className="text-lg font-bold text-zinc-900">Login de Administrador</h2>
                  <p className="text-xs text-zinc-500">
                    Cadastro público de administradores desabilitado por segurança.
                  </p>
                </div>
              </div>
            )}

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

            {(isAdminRoute || mode === 'login') && (
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
                  className="w-full py-3 px-4 bg-[#143824] hover:bg-[#1f5135] disabled:opacity-60 text-white text-sm font-semibold rounded-lg inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Lock className="w-4 h-4" />
                  <span>{loading ? 'Autenticando...' : isAdminRoute ? 'Entrar no Painel Admin' : 'Entrar com CPF'}</span>
                </button>
              </form>
            )}

            {!isAdminRoute && mode === 'register' && (
              <form onSubmit={handleRegister} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Nome completo</label>
                  <input
                    type="text"
                    required
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    placeholder="Nome completo"
                    className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg"
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
                      className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
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
                      className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
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
                    className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg"
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
                      className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-1">Confirmar senha</label>
                    <input
                      type="password"
                      required
                      value={confirmSenha}
                      onChange={(e) => setConfirmSenha(e.target.value)}
                      className="w-full px-3.5 py-2 text-sm border border-zinc-300 rounded-lg"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-xs pt-1">
                  {passwordRules.map((r) => (
                    <div key={r.label} className={r.ok ? 'text-[#143824] font-medium' : 'text-zinc-500'}>
                      {r.ok ? '✓ ' : '· '}
                      {r.label}
                    </div>
                  ))}
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 bg-[#143824] hover:bg-[#1f5135] disabled:opacity-60 text-white text-sm font-semibold rounded-lg cursor-pointer"
                >
                  {loading ? 'Cadastrando...' : 'Criar conta e acessar loja'}
                </button>
              </form>
            )}

            {!isAdminRoute && mode === 'recovery' && (
              <div className="space-y-4">
                {recStep === 'request' ? (
                  <form onSubmit={handleRecoveryRequest} className="space-y-4">
                    <p className="text-sm text-zinc-600">
                      Informe seu CPF cadastrado para enviarmos um código de recuperação ao seu e-mail.
                    </p>
                    <input
                      type="text"
                      required
                      value={recCpf}
                      onChange={(e) => setRecCpf(maskCPF(e.target.value))}
                      placeholder="000.000.000-00"
                      className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                    />
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full py-2.5 px-4 bg-[#143824] text-white text-sm font-semibold rounded-lg cursor-pointer"
                    >
                      {loading ? 'Enviando...' : 'Solicitar código'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleRecoveryReset} className="space-y-4">
                    <input
                      type="text"
                      required
                      maxLength={6}
                      value={recCode}
                      onChange={(e) => setRecCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="Código de 6 dígitos"
                      className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                    />
                    <input
                      type="password"
                      required
                      value={recNewPass}
                      onChange={(e) => setRecNewPass(e.target.value)}
                      placeholder="Nova senha forte"
                      className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg"
                    />
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full py-2.5 px-4 bg-[#143824] text-white text-sm font-semibold rounded-lg cursor-pointer"
                    >
                      {loading ? 'Redefinindo...' : 'Redefinir senha'}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="py-4 px-6 text-center text-xs text-zinc-500">
        Agro Marconato Agropecuária · Rota administrativa: <code className="font-mono-tabular">/admin</code>
      </footer>
    </div>
  );
}
