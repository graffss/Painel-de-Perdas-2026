import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "@/components/ui/sonner";
import { syncThemeWithUser } from "@/lib/forced-theme";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Página não encontrada</h2>
        <div className="mt-6">
          <Link to="/" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            Voltar ao início
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">Algo deu errado</h1>
        <p className="mt-2 text-sm text-muted-foreground">Tente novamente ou volte ao início.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button onClick={() => { router.invalidate(); reset(); }} className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            Tentar novamente
          </button>
          <a href="/" className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">Início</a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Painel de Perdas — Promofarma" },
      { name: "description", content: "Portal corporativo do Painel de Perdas." },
      { property: "og:title", content: "Painel de Perdas — Promofarma" },
      { property: "og:description", content: "Portal corporativo do Painel de Perdas." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#0d1b2a" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "Painel Perdas" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "twitter:title", content: "Painel de Perdas — Promofarma" },
      { name: "twitter:description", content: "Portal corporativo do Painel de Perdas." },
      { property: "og:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/e3f05367-612c-4e17-8bb9-a8d501ec929d" },
      { name: "twitter:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/e3f05367-612c-4e17-8bb9-a8d501ec929d" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icons/icon-192.png" },
      { rel: "icon", type: "image/x-icon", sizes: "192x192", href: "/favicon.ico" },
      { rel: "icon", type: "image/x-icon", sizes: "512x512", href: "/favicon.ico" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => {
    let mounted = true;
    let stopIdle: (() => void) | null = null;

    (async () => {
      const { data } = await supabase.auth.getUser();
      if (mounted) syncThemeWithUser(data.user?.email);
      if (!mounted || !data.user) return;
      const idle = await import("@/lib/idle-timeout");
      if (idle.isIdleExpired()) {
        await idle.expireSession();
        return;
      }
      stopIdle = idle.startIdleTimeout(() => {
        idle.expireSession().catch(() => {});
      });
      const { startAccessLog } = await import("@/lib/access-log");
      startAccessLog(data.user.id, data.user.email ?? "").catch(() => {});
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      // Tema por usuário: escuro só para e-mails forçados; claro ao sair/trocar.
      syncThemeWithUser(session?.user?.email);
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      const mod = await import("@/lib/access-log");
      const idle = await import("@/lib/idle-timeout");
      if (event === "SIGNED_IN" && session?.user) {
        mod.startAccessLog(session.user.id, session.user.email ?? "").catch(() => {});
        stopIdle?.();
        stopIdle = idle.startIdleTimeout(() => {
          idle.expireSession().catch(() => {});
        });
      } else if (event === "SIGNED_OUT") {
        mod.endAccessLog().catch(() => {});
        stopIdle?.();
        stopIdle = null;
      }
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => { mounted = false; stopIdle?.(); sub.subscription.unsubscribe(); };
  }, [router, queryClient]);


  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster />
    </QueryClientProvider>
  );
}
