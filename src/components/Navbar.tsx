import { ShoppingBag, ShieldCheck, User as UserIcon, LogOut, Menu, X } from 'lucide-react';
import { useState } from 'react';
import type { User } from '../types.ts';

interface NavbarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  user: User | null;
  cartCount: number;
  onOpenCart: () => void;
  onOpenAuth: (mode?: 'login' | 'register' | 'verify') => void;
  onLogout: () => void;
}

export function Navbar({
  currentPath,
  onNavigate,
  user,
  cartCount,
  onOpenCart,
  onOpenAuth,
  onLogout,
}: NavbarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinkClass = (active: boolean) =>
    `text-sm font-medium transition-colors whitespace-nowrap shrink-0 pb-0.5 border-b-2 ${
      active
        ? 'text-[#143824] border-[#143824]'
        : 'text-zinc-600 border-transparent hover:text-[#143824] hover:border-zinc-300'
    }`;

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-sm border-b border-zinc-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Single-element brand wordmark */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
            setMobileOpen(false);
          }}
          className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-[#143824] whitespace-nowrap shrink-0"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="text-[#143824] shrink-0"
          >
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

        {/* Zone 2: 4-5 concise single-line text nav links */}
        <nav className="hidden md:flex items-center gap-7" aria-label="Navegação principal">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/');
            }}
            className={navLinkClass(currentPath === '/')}
          >
            Catálogo
          </a>
          <a
            href="/ofertas"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/ofertas');
            }}
            className={navLinkClass(currentPath === '/ofertas')}
          >
            Ofertas
          </a>
          <a
            href="/meus-pedidos"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/meus-pedidos');
            }}
            className={navLinkClass(currentPath === '/meus-pedidos')}
          >
            Meus Pedidos
          </a>
          <a
            href="/atendimento"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/atendimento');
            }}
            className={navLinkClass(currentPath === '/atendimento')}
          >
            Atendimento
          </a>
          {user?.papel === 'ADMIN' && (
            <a
              href="/admin"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/admin');
              }}
              className={navLinkClass(currentPath === '/admin')}
            >
              Painel Admin
            </a>
          )}
        </nav>

        {/* Zone 3: Account & Cart action */}
        <div className="flex items-center gap-3 shrink-0">
          {user ? (
            <div className="hidden sm:flex items-center gap-3">
              {user.papel === 'CLIENTE' && (!user.email_verificado || !user.telefone_verificado) && (
                <button
                  type="button"
                  onClick={() => onOpenAuth('verify')}
                  className="text-xs font-medium text-amber-800 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Confirmar contato
                </button>
              )}
              <button
                type="button"
                onClick={() => onNavigate(user.papel === 'ADMIN' ? '/admin' : '/meus-pedidos')}
                className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 hover:text-[#143824] whitespace-nowrap shrink-0 cursor-pointer"
                title={user.nome_completo}
              >
                {user.papel === 'ADMIN' ? (
                  <ShieldCheck className="w-4 h-4 text-[#143824]" />
                ) : (
                  <UserIcon className="w-4 h-4 text-zinc-500" />
                )}
                <span className="max-w-[130px] truncate">{user.nome_completo.split(' ')[0]}</span>
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="p-2 text-zinc-500 hover:text-zinc-900 rounded-md hover:bg-zinc-100 transition-colors cursor-pointer"
                aria-label="Sair da conta"
                title="Sair"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onOpenAuth('login')}
              className="hidden sm:inline-flex text-sm font-medium text-zinc-700 hover:text-[#143824] whitespace-nowrap shrink-0 px-2 py-1.5 cursor-pointer"
            >
              Entrar
            </button>
          )}

          {user?.papel !== 'ADMIN' && (
            <button
              type="button"
              onClick={onOpenCart}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#143824] hover:bg-[#1f5135] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ShoppingBag className="w-4 h-4" />
              <span>Carrinho</span>
              <span className="font-mono-tabular text-xs bg-white/15 px-1.5 py-0.5 rounded">
                {cartCount}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="md:hidden p-2 text-zinc-700 hover:bg-zinc-100 rounded-md"
            aria-label="Abrir menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile navigation drawer */}
      {mobileOpen && (
        <div className="md:hidden border-t border-zinc-200 bg-white px-4 py-4 space-y-3">
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                onNavigate('/');
                setMobileOpen(false);
              }}
              className="text-left py-2 text-sm font-medium text-zinc-800"
            >
              Catálogo
            </button>
            <button
              type="button"
              onClick={() => {
                onNavigate('/ofertas');
                setMobileOpen(false);
              }}
              className="text-left py-2 text-sm font-medium text-zinc-800"
            >
              Ofertas
            </button>
            <button
              type="button"
              onClick={() => {
                onNavigate('/meus-pedidos');
                setMobileOpen(false);
              }}
              className="text-left py-2 text-sm font-medium text-zinc-800"
            >
              Meus Pedidos
            </button>
            <button
              type="button"
              onClick={() => {
                onNavigate('/atendimento');
                setMobileOpen(false);
              }}
              className="text-left py-2 text-sm font-medium text-zinc-800"
            >
              Atendimento
            </button>
            {user?.papel === 'ADMIN' && (
              <button
                type="button"
                onClick={() => {
                  onNavigate('/admin');
                  setMobileOpen(false);
                }}
                className="text-left py-2 text-sm font-semibold text-[#143824]"
              >
                Painel Admin
              </button>
            )}
          </div>
          <div className="pt-3 border-t border-zinc-200 flex items-center justify-between">
            {user ? (
              <>
                <span className="text-sm text-zinc-700 truncate">{user.nome_completo}</span>
                <button
                  type="button"
                  onClick={() => {
                    onLogout();
                    setMobileOpen(false);
                  }}
                  className="text-sm font-medium text-red-700"
                >
                  Sair
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onOpenAuth('login');
                  setMobileOpen(false);
                }}
                className="w-full py-2.5 text-center text-sm font-medium text-[#143824] border border-[#143824] rounded-lg"
              >
                Entrar ou Criar Conta
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
