import { useSession } from "./auth/useSession";
import LoginPage from "./pages/LoginPage";
import PanelLayout from "./pages/PanelLayout";

export default function App() {
  const session = useSession();

  // 'loading' renderiza un estado neutro — NUNCA el login. Si colapsara
  // con 'unauthenticated' cada recarga de página mostraría el login por
  // un instante antes de entrar al panel (ver auth/useSession.ts).
  if (session.status === "loading") {
    return <div className="min-h-dvh bg-panel-50" />;
  }

  if (session.status === "unauthenticated") {
    return <LoginPage onLogin={session.login} />;
  }

  return <PanelLayout user={session.user} onLogout={session.logout} onLogoutAll={session.logoutAll} />;
}
