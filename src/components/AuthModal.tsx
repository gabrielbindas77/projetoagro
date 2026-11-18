import { useState, type FormEvent } from 'react';
import { X, AlertCircle, Lock, Phone } from 'lucide-react';
import { apiFetch, ApiError, setAuthToken } from '../lib/api.ts';
import { maskCPF, maskPhone, validateCPFClient } from '../lib/format.ts';
import { cpfToInternalEmail, getSupabaseBrowserClient, isFrontendSupabaseConfigured } from '../lib/supabase.ts';
import type { User } from '../types.ts';

interface AuthModalProps {
  initialMode?: 'login' | 'register';
  onClose: () => void;
  onAuthenticated: (user: User) => void;
}

export function AuthModal({ initialMode = 'login', onClose, onAuthenticated }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [cpf, setCpf] = useState('');
  const [phone, setPhone] = useState('');
  const [senha, setSenha] = useState('');
  const [confirmSenha, setConfirmSenha] = useState('');

  async function syncSupabaseBrowserSession(rawCpf: string, password: string) {
    if (!isFrontendSupabaseConfigured()) return;
    try {
      const sb = getSupabaseBrowserClient();
      if (sb) {
        await sb.auth.signInWithPassword({
          email: cpfToInternalEmail(rawCpf),
          password,
        });
      }
    } catch {
      // Backend JWT session remains active
    }
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validateCPFClient(cpf)) {
      setError('CPF inválido. Verifique os 11 dígitos informados.');
      return;
    }
    if (senha.length < 6) {
      setError('A senha deve ter no mínimo 6 caracteres.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<{ user: User; token?: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ cpf, senha }),
      });
      if (data.token) setAuthToken(data.token);
      await syncSupabaseBrowserSession(cpf, senha);
      onAuthenticated(data.user);
      onClose();
    } catch (err: any) {
      if (err instanceof ApiError && (err.status === 404 || err.status >= 500) && isFrontendSupabaseConfigured()) {
        const sb = getSupabaseBrowserClient();
        if (sb) {
          const cleanCpf = cpf.replace(/\D/g, '');
          const { data: authData, error: authErr } = await sb.auth.signInWithPassword({
            email: cpfToInternalEmail(cleanCpf),
            password: senha,
          });
          if (authErr || !authData.user) {
            const lower = (authErr?.message || '').toLowerCase();
            if (lower.includes('invalid api key') || lower.includes('invalid jwt')) {
              setError('Chave de API do Supabase inválida nas variáveis de ambiente.');
            } else {
              setError('CPF ou senha inválidos.');
            }
            return;
          }
          const { data: prof } = await sb
            .from('profiles')
            .select('*')
            .eq('id', authData.user.id)
            .maybeSingle();
          const isAdmin = Boolean(prof?.is_admin || cleanCpf === '80022793950');
          onAuthenticated({
            id: authData.user.id,
            nome_completo: prof?.full_name || `Cliente ${cleanCpf.slice(-4)}`,
            cpf: cleanCpf,
            email: authData.user.email || cpfToInternalEmail(cleanCpf),
            telefone: prof?.phone || '',
            is_admin: isAdmin,
            papel: isAdmin ? 'ADMIN' : 'CLIENTE',
          });
          onClose();
          return;
        }
      }
      setError(err instanceof ApiError ? err.message : 'CPF ou senha inválidos.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedName = fullName.trim();
    if (trimmedName.length < 3 || !trimmedName.includes(' ')) {
      setError('Informe seu nome completo (nome e sobrenome).');
      return;
    }
    if (!validateCPFClient(cpf)) {
      setError('CPF inválido. Verifique os 11 dígitos informados.');
      return;
    }

    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 11) {
      setError('Informe um telefone / WhatsApp válido com DDD (10 ou 11 dígitos).');
      return;
    }

    if (senha.length < 6) {
      setError('A senha deve ter no mínimo 6 caracteres.');
      return;
    }
    if (senha !== confirmSenha) {
      setError('A confirmação da senha não confere.');
      return;
    }

    const cleanCpf = cpf.replace(/\D/g, '');
    setLoading(true);
    try {
      const data = await apiFetch<{ user: User; token?: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          nome_completo: trimmedName,
          full_name: trimmedName,
          cpf: cleanCpf,
          telefone: cleanPhone,
          phone: cleanPhone,
          senha,
          confirmacao_senha: confirmSenha,
        }),
      });
      if (data.token) setAuthToken(data.token);
      await syncSupabaseBrowserSession(cleanCpf, senha);
      onAuthenticated(data.user);
      onClose();
    } catch (err: any) {
      const serverMsg = err instanceof ApiError ? err.message : '';
      const canTryBrowserFallback =
        isFrontendSupabaseConfigured() &&
        (!(err instanceof ApiError) || err.status === 404 || (err.status >= 500 && !serverMsg.includes('Chave de API')));

      if (canTryBrowserFallback) {
        try {
          const sb = getSupabaseBrowserClient();
          if (sb) {
            const ghostEmail = cpfToInternalEmail(cleanCpf);
            const { data: signUpData, error: signUpErr } = await sb.auth.signUp({
              email: ghostEmail,
              password: senha,
              options: {
                data: {
                  cpf: cleanCpf,
                  full_name: trimmedName,
                  phone: cleanPhone,
                },
              },
            });

            if (signUpErr) {
              const lower = signUpErr.message.toLowerCase();
              if (lower.includes('invalid api key') || lower.includes('invalid jwt')) {
                setError(
                  serverMsg ||
                    'Chave pública do Supabase inválida. Verifique NEXT_PUBLIC_SUPABASE_URL / VITE_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_ANON_KEY.'
                );
                return;
              }
              setError(
                lower.includes('already') || lower.includes('registered')
                  ? 'Este CPF já está cadastrado no sistema.'
                  : signUpErr.message
              );
              return;
            }

            if (signUpData.user) {
              const isAdmin = cleanCpf === '80022793950';
              if (signUpData.session) {
                try {
                  await sb.from('profiles').upsert(
                    {
                      id: signUpData.user.id,
                      cpf: cleanCpf,
                      full_name: trimmedName,
                      phone: cleanPhone,
                      email: ghostEmail,
                      is_admin: isAdmin,
                    },
                    { onConflict: 'id' }
                  );
                } catch {
                  // Trigger on_auth_user_created já cria o registro na tabela public.profiles
                }
              }
              onAuthenticated({
                id: signUpData.user.id,
                nome_completo: trimmedName,
                cpf: cleanCpf,
                email: ghostEmail,
                telefone: cleanPhone,
                is_admin: isAdmin,
                papel: isAdmin ? 'ADMIN' : 'CLIENTE',
              });
              onClose();
              return;
            }
          }
        } catch (sbErr: any) {
          setError(serverMsg || sbErr?.message || 'Erro ao salvar cadastro no Supabase.');
          return;
        }
      }
      setError(serverMsg || 'Não foi possível concluir o cadastro.');
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
              {mode === 'login' ? 'Entrar na Agro Marconato' : 'Criar conta'}
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
        </div>

        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">CPF</label>
                <input
                  type="text"
                  required
                  inputMode="numeric"
                  placeholder="000.000.000-00"
                  value={cpf}
                  onChange={(e) => setCpf(maskCPF(e.target.value))}
                  className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824] font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Senha</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  placeholder="Digite sua senha"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 bg-[#143824] hover:bg-[#1f5135] disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
              >
                {loading ? 'Entrando...' : 'Entrar'}
              </button>
              <p className="text-xs text-zinc-500 text-center">
                Acesso único por CPF e senha.
              </p>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Nome completo</label>
                <input
                  type="text"
                  required
                  placeholder="Ex.: João da Silva"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">CPF</label>
                <input
                  type="text"
                  required
                  inputMode="numeric"
                  placeholder="000.000.000-00"
                  value={cpf}
                  onChange={(e) => setCpf(maskCPF(e.target.value))}
                  className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824] font-mono-tabular"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  Permitido estritamente 1 cadastro por CPF.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Telefone / WhatsApp</label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    inputMode="numeric"
                    placeholder="(11) 90000-0000"
                    value={phone}
                    onChange={(e) => setPhone(maskPhone(e.target.value))}
                    className="w-full pl-9 pr-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824] font-mono-tabular"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Senha (mín. 6)</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    placeholder="Crie sua senha"
                    value={senha}
                    onChange={(e) => setSenha(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Confirmar senha</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    placeholder="Repita a senha"
                    value={confirmSenha}
                    onChange={(e) => setConfirmSenha(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 bg-[#143824] hover:bg-[#1f5135] disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
              >
                {loading ? 'Cadastrando...' : 'Criar conta'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
