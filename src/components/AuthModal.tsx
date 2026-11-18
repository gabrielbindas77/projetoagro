import { useState, type FormEvent } from 'react';
import { X, AlertCircle, Lock } from 'lucide-react';
import { apiFetch, ApiError, setAuthToken } from '../lib/api.ts';
import { maskCPF, validateCPFClient } from '../lib/format.ts';
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

  const [cpf, setCpf] = useState('');
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
      // Backend JWT session remains active even if browser client sync is skipped
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
      setError(err instanceof ApiError ? err.message : 'CPF ou senha inválidos.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: FormEvent) {
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
    if (senha !== confirmSenha) {
      setError('A confirmação da senha não confere.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<{ user: User; token?: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          cpf,
          senha,
          confirmacao_senha: confirmSenha,
        }),
      });
      if (data.token) setAuthToken(data.token);
      await syncSupabaseBrowserSession(cpf, senha);
      onAuthenticated(data.user);
      onClose();
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível concluir o cadastro.');
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
            <form onSubmit={handleRegister} className="space-y-4">
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
                <label className="block text-xs font-medium text-zinc-700 mb-1">Senha (mín. 6 caracteres)</label>
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
                  placeholder="Repita sua senha"
                  value={confirmSenha}
                  onChange={(e) => setConfirmSenha(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                />
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
