import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import {
  Loader2,
  LogOut,
  Settings,
  RotateCw,
  RotateCcw,
  Smartphone,
  CheckCircle2,
  Circle,
  Maximize,
  Minimize,
  MoreVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { UpdateBell } from "@/components/UpdateBell";
import { fetchRemoteVersions, markVersionsLoaded } from "@/lib/app-updates";
import { readCachedData, remoteVersion, writeCachedData } from "@/lib/dashboard-cache";
import { PanelSearch } from "@/components/dashboard/PanelSearch";
import { applyState, queryToState, readState, stateToQuery } from "@/lib/panel-bridge";
import { applyThemeToPanelDocument } from "@/lib/forced-theme";
import {
  armImmersiveOnFirstGesture,
  enterImmersive,
  exitImmersive,
  isFullscreenActive,
  isHandheld,
  isPortraitViewport,
  isStandalonePWA,
  prefersImmersive,
  setImmersivePreference,
} from "@/lib/immersive-mode";

type LoadingStep = {
  key: string;
  label: string;
  min: number;
  max: number;
};

const LOADING_STEPS: LoadingStep[] = [
  { key: "prepare", label: "Preparar painel", min: 0, max: 10 },
  { key: "download", label: "Baixar base de dados", min: 10, max: 70 },
  { key: "process", label: "Processar planilha", min: 70, max: 92 },
  { key: "scope", label: "Aplicar filtros de escopo", min: 92, max: 99 },
  { key: "finish", label: "Concluído", min: 99, max: 100 },
];

export const Route = createFileRoute("/_authenticated/dashboard")({
  ssr: false,
  component: DashboardPage,
});

type Profile = {
  id: string;
  email: string;
  role: string;
  status: string;
  scope_via: string | null;
  scope_regional: string | null;
  scope_loja: string | null;
  data_file?: string | null;
};

function DashboardPage() {
  const { profile } = Route.useRouteContext() as { profile: Profile };
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<string>("Carregando painel...");
  const [progress, setProgress] = useState<number>(2);
  const [error, setError] = useState<string | null>(null);
  // O painel deve abrir deitado e em tela cheia. `isLandscape` já nasce ligado
  // em aparelho de mão: se o sistema não girar a tela fisicamente (iPhone), a
  // rotação por CSS abaixo assume e o painel abre deitado do mesmo jeito.
  const [isLandscape, setIsLandscape] = useState(
    () => prefersImmersive() && isHandheld() && isPortraitViewport(),
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** Tela cheia pedida mas ainda pendente do primeiro toque do usuário. */
  const [awaitingGesture, setAwaitingGesture] = useState(false);
  const [vp, setVp] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [retryKey, setRetryKey] = useState(0);
  const injectedRef = useRef(false);
  // Documento do iframe, publicado no estado assim que o painel termina de
  // renderizar — é o que habilita a busca global (Ctrl+K) e os chips de filtro.
  const [frameDoc, setFrameDoc] = useState<Document | null>(null);

  useEffect(() => {
    const read = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);

  const rotated = isLandscape && vp.w > 0 && vp.w < vp.h;

  const [elapsed, setElapsed] = useState(0);
  const [stalled, setStalled] = useState(0);
  const lastProgressAt = useRef<number>(Date.now());
  const startedAt = useRef<number>(Date.now());

  // Cronômetro do carregamento: mantém sinais visíveis de que o sistema segue
  // trabalhando mesmo quando a porcentagem fica parada (leitura da planilha).
  useEffect(() => {
    if (!status) return;
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      setStalled(Math.floor((Date.now() - lastProgressAt.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  const step = (pct: number, msg: string) => {
    setProgress((prev) => {
      if (pct !== prev) lastProgressAt.current = Date.now();
      return pct;
    });
    setStatus(msg);
  };

  const handleRetry = () => {
    injectedRef.current = false;
    setFrameDoc(null);
    setError(null);
    setProgress(2);
    setStatus("Carregando painel...");
    setElapsed(0);
    setStalled(0);
    startedAt.current = Date.now();
    lastProgressAt.current = Date.now();
    setRetryKey((k) => k + 1);
  };

  /**
   * Mantém a barra de endereço em sincronia com os filtros do painel, para
   * que recarregar a página (ou compartilhar o link) preserve a visão atual.
   * Usa replaceState: não polui o histórico do navegador.
   */
  const syncUrlWithFilters = () => {
    try {
      const query = stateToQuery(readState(frameRef.current?.contentDocument ?? null));
      const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
      window.history.replaceState(null, "", next);
    } catch {
      /* history pode estar bloqueado em alguns contextos */
    }
  };

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/auth";
  }

  /**
   * Entra em modo imersivo (tela cheia + paisagem). Chamado tanto pelo botão
   * quanto pelo primeiro toque do usuário, já que o navegador exige gesto.
   */
  const goImmersive = useCallback(async () => {
    const result = await enterImmersive();
    setAwaitingGesture(false);
    setIsFullscreen(result.fullscreen || isFullscreenActive());
    // Se o sistema girou a tela de verdade, a rotação por CSS é dispensada.
    setIsLandscape(!result.orientationLocked && isHandheld() && isPortraitViewport());
    return result;
  }, []);

  async function toggleLandscape() {
    const next = !isLandscape;
    setIsLandscape(next);
    try {
      const screenAny = window.screen as unknown as {
        orientation?: { lock?: (o: string) => Promise<void>; unlock?: () => void };
      };
      if (next) await screenAny.orientation?.lock?.("landscape");
      else screenAny.orientation?.unlock?.();
    } catch {
      // A API de orientação pode não estar disponível ou ser bloqueada.
    }
  }

  async function toggleFullscreen() {
    if (isFullscreen || isFullscreenActive()) {
      // Sair é uma escolha explícita: o app para de insistir nas próximas vezes.
      setImmersivePreference(false);
      await exitImmersive();
      setIsFullscreen(false);
      setAwaitingGesture(false);
      return;
    }
    setImmersivePreference(true);
    await goImmersive();
  }

  useEffect(() => {
    function onFullscreenChange() {
      const active = isFullscreenActive();
      setIsFullscreen(active);
      // Saiu pelo ESC ou pelo gesto do sistema: respeita e não insiste mais.
      if (!active) setAwaitingGesture(false);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  /**
   * Abertura imersiva automática, disparada quando o painel termina de montar.
   *
   * Instalado como PWA, o manifest já abre em paisagem e tela cheia — não há
   * nada a fazer. No navegador comum, tentamos entrar direto; se o navegador
   * recusar por falta de gesto (o padrão), armamos o primeiro toque.
   */
  useEffect(() => {
    if (!frameDoc || !prefersImmersive()) return;
    if (isStandalonePWA() || isFullscreenActive()) return;

    let cancelled = false;
    let disarm: (() => void) | null = null;

    (async () => {
      const result = await enterImmersive();
      if (cancelled) return;
      if (result.fullscreen) {
        setIsFullscreen(true);
        setIsLandscape(!result.orientationLocked && isHandheld() && isPortraitViewport());
        return;
      }
      // Bloqueado por falta de gesto: mostra o convite discreto.
      setAwaitingGesture(true);

      // Só em aparelho de mão o primeiro toque entra automaticamente. No
      // desktop isso seria sequestro: a pessoa clica num filtro e o navegador
      // vira tela cheia sem ela ter pedido. Lá, o botão é a única porta.
      if (!isHandheld()) return;

      disarm = armImmersiveOnFirstGesture((r) => {
        if (cancelled) return;
        setAwaitingGesture(false);
        setIsFullscreen(r.fullscreen);
        setIsLandscape(!r.orientationLocked && isHandheld() && isPortraitViewport());
      }, frameDoc);
    })();

    return () => {
      cancelled = true;
      disarm?.();
    };
  }, [frameDoc]);

  useEffect(() => {
    if (injectedRef.current) return;
    injectedRef.current = true;

    (async () => {
      try {
        // ===== 1. Resolve URLs (HTML + base) em paralelo =====
        step(2, "Preparando painel...");

        const dataTarget = (async (): Promise<{ path: string; url: string } | null> => {
          const isGlobal = !profile.data_file || profile.data_file === "global.xlsx";
          const candidates = isGlobal
            ? ["dados.xlsx", "dados.compact.xlsx", "scoped/global.xlsx"]
            : [`scoped/${profile.data_file}`];
          for (const path of candidates) {
            const url = await signedUrl("dashboard_data", path);
            if (url) return { path, url };
          }
          return null;
        })();

        const htmlUrlPromise = signedUrl("dashboard_assets", "painel.html");

        // ===== 2. Base de dados: começa AGORA, em paralelo com o boot do
        //    iframe (antes era sequencial). Se o arquivo publicado não mudou,
        //    reaproveita o download anterior do cache do navegador.
        const dataPromise = (async (): Promise<Blob | null> => {
          const target = await dataTarget;
          if (!target) return null;
          const { version } = await remoteVersion(target.url);
          const cached = await readCachedData(target.path, version);
          if (cached) {
            step(70, "Base de dados carregada do cache local");
            return cached;
          }
          const blob = await fetchWithProgress(target.url, (frac, label) =>
            step(10 + Math.round(frac * 60), `Baixando base de dados... ${label}`),
          );
          void writeCachedData(target.path, version, blob);
          return blob;
        })();

        // ===== 3. HTML do painel (leve) e boot do iframe =====
        const htmlUrl = await htmlUrlPromise;
        if (!htmlUrl)
          throw new Error("HTML do painel não encontrado. Peça ao Master para fazer o upload.");
        const htmlText = await (await fetch(htmlUrl)).text();
        const frame = frameRef.current;
        if (!frame) throw new Error("Não foi possível preparar a área do painel.");
        const frameLoaded = waitForFrameLoad(frame, 30000);
        frame.srcdoc = optimizeDashboardHtml(htmlText);
        await frameLoaded;
        const frameWindow = frame.contentWindow;
        const frameDocument = frame.contentDocument;
        if (!frameWindow || !frameDocument)
          throw new Error("Não foi possível acessar o painel carregado.");
        applyThemeToPanelDocument(frameDocument, profile.email);

        const xlsxBlob = await dataPromise;
        if (!xlsxBlob) {
          setStatus("");
          setProgress(0);
          if (profile.role === "MASTER") {
            toast.info("Nenhuma base de dados encontrada. Faça upload pelo painel admin.");
          } else {
            setError(
              "Base de dados ainda não disponível para o seu acesso. Peça ao Master para vincular o arquivo do seu escopo.",
            );
          }
          return;
        }
        const file = new File([xlsxBlob], "dados.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        // ===== 4. Parse XLSX: 70-92% =====
        step(70, "Processando planilha (pode levar alguns segundos)...");
        await waitFor(
          () => {
            const candidate = frameWindow as unknown as {
              handleFile?: unknown;
              XLSX?: { read?: unknown };
            };
            return (
              typeof candidate.handleFile === "function" &&
              typeof candidate.XLSX?.read === "function"
            );
          },
          30000,
          "A biblioteca de leitura do Excel não ficou disponível.",
        );
        const w = frameWindow as unknown as {
          handleFile: (e: { target: { files: File[] } }) => void;
          renderDashboard?: () => void;
          lojaInfoMap?: Map<string, { regional?: string }>;
        };

        const processing = waitForDashboardProcessing(frameWindow, (pct, text, note) => {
          const mapped = 70 + Math.round(Math.min(100, Math.max(0, pct)) * 0.22);
          step(mapped, note ? `${text} ${note}` : text);
        });
        w.handleFile({ target: { files: [file] } });
        await processing;
        step(92, "Renderizando painel...");

        // ===== 4. Escopo: 92-99% =====
        step(95, "Aplicando filtros de escopo...");
        applyScope(profile, frameDocument, w);

        await waitFor(
          () => dashboardHasExpectedContent(frameDocument),
          30000,
          "O processamento terminou, mas os indicadores não foram renderizados.",
        );

        // Filtros vindos da URL (link compartilhado). Aplicados só depois do
        // escopo, para que a trava de Regional/Loja nunca seja sobrescrita.
        const urlState = queryToState(window.location.search);
        if (Object.keys(urlState).length > 0) {
          const applied = applyState(frameDocument, urlState);
          if (applied > 0) toast.info(`${applied} filtro(s) do link aplicados.`);
        }
        setFrameDoc(frameDocument);

        step(100, "Concluído");
        toast.success(
          `Bem-vindo, ${profile.email}! Acesso como ${roleLabel(profile.role)} carregado com sucesso.`,
          { duration: 6000 },
        );
        fetchRemoteVersions(profile.data_file)
          .then((versions) => markVersionsLoaded(versions, profile.data_file))
          .catch(() => {});
        setTimeout(() => setStatus(""), 500);
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : "Erro ao carregar painel.");
        setStatus("");
      }
    })();
  }, [profile, retryKey]);

  return (
    <div className="relative h-screen w-full overflow-hidden">
      {status && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/95 backdrop-blur">
          <div className="w-full max-w-md px-6 text-center">
            <div className="relative mx-auto h-16 w-16">
              <span className="absolute inset-0 rounded-full border-2 border-primary/25" />
              <span className="pf-pulse absolute inset-0 rounded-full border-2 border-primary/40" />
              <Loader2 className="absolute inset-0 m-auto h-8 w-8 animate-spin text-primary" />
            </div>
            <p className="mt-4 text-sm font-medium text-foreground">{status}</p>
            <div className="relative mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
              {/* Faixa em movimento: sinaliza atividade mesmo com % parada */}
              <div className="pf-shimmer pointer-events-none absolute inset-y-0 left-0 w-1/3 rounded-full" />
            </div>
            <div className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{progress}%</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
              </span>
            </div>

            {/* Etapas reais do carregamento */}
            <div className="mt-5 rounded-lg border bg-card/50 p-3 text-left">
              <ol className="space-y-2">
                {(() => {
                  const currentStepIndex = (() => {
                    const pending = LOADING_STEPS.findIndex((x) => progress < x.max);
                    return pending === -1 ? LOADING_STEPS.length - 1 : pending;
                  })();
                  return LOADING_STEPS.map((s, idx) => {
                    const completed = progress >= s.max;
                    const isCurrent = currentStepIndex === idx;
                    return (
                      <li key={s.key} className="flex items-center gap-3 text-sm">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                          {completed ? (
                            <CheckCircle2 className="h-4 w-4 text-primary" />
                          ) : isCurrent ? (
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                          ) : (
                            <Circle className="h-4 w-4 text-muted-foreground/60" />
                          )}
                        </span>
                        <span
                          className={
                            completed || isCurrent
                              ? "font-medium text-foreground"
                              : "text-muted-foreground"
                          }
                        >
                          {s.label}
                        </span>
                      </li>
                    );
                  });
                })()}
              </ol>
            </div>

            <p className="mt-4 min-h-[2rem] text-xs text-muted-foreground">
              {stalled >= 6
                ? "Etapa demorada em andamento — o sistema continua trabalhando. Não feche nem recarregue a página."
                : "Processando... isso pode levar alguns minutos em bases grandes."}
            </p>

            {stalled >= 15 && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={handleRetry}
                disabled={!status}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Reiniciar carregamento
              </Button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="max-w-md text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <LogOut className="h-6 w-6 text-destructive" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Não foi possível carregar o painel</h2>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <div className="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
              <Button onClick={handleRetry}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Tentar novamente
              </Button>
              {profile.role === "MASTER" && (
                <Button variant="outline" asChild>
                  <Link to="/admin">Ir para Admin</Link>
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Container que gira no modo paisagem — botões e iframe giram juntos */}
      <div
        className="fixed left-0 top-0 origin-top-left overflow-hidden bg-background"
        style={
          rotated
            ? {
                width: `${vp.h}px`,
                height: `${vp.w}px`,
                transform: `translateY(${vp.h}px) rotate(-90deg)`,
              }
            : { width: "100%", height: "100%", transform: "none" }
        }
      >
        {/*
          Barra superior direita.

          Antes eram SEIS botões soltos numa linha (Buscar, sino, tela cheia,
          girar, admin, sair) e os chips de filtro caíam por cima deles no
          canto. Em tela de celular deitada não havia espaço para nada disso.

          Agora o PanelSearch é o contêiner: linha 1 = ações, linha 2 = chips,
          empilhadas na mesma coluna — não há como se sobrepor. E as ações
          secundárias foram para um menu, deixando visível só o que se usa o
          tempo todo: Buscar e o sino de atualizações.
        */}
        <PanelSearch doc={frameDoc} onApplied={syncUrlWithFilters}>
          <UpdateBell dataFile={profile.data_file ?? null} active={profile.status === "APPROVED"} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="secondary" className="shadow-sm" title="Mais ações">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={toggleFullscreen}>
                {isFullscreen ? (
                  <Minimize className="mr-2 h-4 w-4" />
                ) : (
                  <Maximize className="mr-2 h-4 w-4" />
                )}
                {isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggleLandscape}>
                {isLandscape ? (
                  <Smartphone className="mr-2 h-4 w-4" />
                ) : (
                  <RotateCw className="mr-2 h-4 w-4" />
                )}
                {isLandscape ? "Modo retrato" : "Modo paisagem"}
              </DropdownMenuItem>
              {profile.role === "MASTER" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/admin">
                      <Settings className="mr-2 h-4 w-4" />
                      Painel administrativo
                    </Link>
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={signOut}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PanelSearch>

        {/* O navegador só concede tela cheia dentro de um gesto do usuário.
            Quando a tentativa automática é recusada, este aviso discreto
            aparece — e some sozinho no primeiro toque, que já entra em
            imersivo pelo handler armado. */}
        {awaitingGesture && !isFullscreen && (
          <button
            type="button"
            onClick={goImmersive}
            className="absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/95 px-4 py-2 text-xs font-medium shadow-lg backdrop-blur transition hover:bg-accent"
          >
            <Maximize className="h-3.5 w-3.5" />
            Toque para abrir em tela cheia
          </button>
        )}

        <iframe
          ref={frameRef}
          title="Painel de perdas"
          className="h-full w-full border-0 bg-background"
          sandbox="allow-scripts allow-same-origin allow-downloads allow-modals"
        />
      </div>
    </div>
  );
}

async function signedUrl(bucket: string, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

function fmtMB(bytes: number): string {
  if (!bytes || !Number.isFinite(bytes)) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchWithProgress(
  url: string,
  onProgress: (fraction: number, label: string) => void,
): Promise<Blob> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new Error(`Falha ao baixar (${resp.status})`);
  return readBodyWithProgress(resp, onProgress);
}

async function readBodyWithProgress(
  resp: Response,
  onProgress: (fraction: number, label: string) => void,
): Promise<Blob> {
  if (!resp.body) throw new Error("Resposta sem corpo");
  const total = Number(resp.headers.get("content-length") || 0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastEmit = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const now = Date.now();
    if (now - lastEmit > 120) {
      lastEmit = now;
      const frac = total ? received / total : Math.min(0.95, received / (received + 5_000_000));
      const label = total ? `${fmtMB(received)} / ${fmtMB(total)}` : fmtMB(received);
      onProgress(Math.min(1, frac), label);
    }
  }
  onProgress(1, total ? `${fmtMB(total)} / ${fmtMB(total)}` : fmtMB(received));
  return new Blob(chunks as BlobPart[]);
}

function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  timeoutMessage = "Tempo esgotado ao renderizar painel.",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (cond()) return resolve();
      } catch {
        /* ignore */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(timeoutMessage));
      setTimeout(tick, 150);
    };
    tick();
  });
}

function waitForFrameLoad(frame: HTMLIFrameElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("Tempo esgotado ao abrir o painel.")),
      timeoutMs,
    );
    frame.addEventListener(
      "load",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function waitForDashboardProcessing(
  target: Window,
  onProgress: (pct: number, text: string, note: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      target.removeEventListener("pf-dashboard-progress", progressListener as EventListener);
      target.removeEventListener("pf-dashboard-error", errorListener as EventListener);
      error ? reject(error) : resolve();
    };
    const progressListener = (event: Event) => {
      const detail =
        (event as CustomEvent<{ pct?: number; text?: string; note?: string }>).detail ?? {};
      const pct = Number(detail.pct ?? 0);
      onProgress(pct, detail.text || "Processando planilha...", detail.note || "");
      if (pct >= 100) finish();
    };
    const errorListener = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      finish(new Error(detail?.message || "Falha ao processar a planilha."));
    };
    target.addEventListener("pf-dashboard-progress", progressListener as EventListener);
    target.addEventListener("pf-dashboard-error", errorListener as EventListener);
    timeout = window.setTimeout(
      () => finish(new Error("O processamento da planilha excedeu 5 minutos.")),
      300000,
    );
  });
}

/**
 * Blindagem do painel (opção 1 + CSP):
 * 1) Content-Security-Policy embutida no próprio srcdoc: permite só os scripts
 *    do CDN usados pelo painel, bloqueia qualquer conexão de rede
 *    (connect-src 'none'), iframes, plugins e envio de formulários — assim,
 *    mesmo que algum conteúdo da planilha consiga executar algo, não há como
 *    exfiltrar dados nem chamar o backend.
 * 2) Sanitização no "sink": todo HTML atribuído via innerHTML /
 *    insertAdjacentHTML é filtrado antes de entrar no DOM. Remove
 *    <script>/<iframe>/<object>/<embed>/<link>/<meta>/<base>/<form>, URLs
 *    javascript:, atributos srcdoc/formaction e handlers inline que não
 *    pertençam à lista de funções do próprio painel.
 */
export function hardenDashboardHtml(html: string): string {
  // Nomes de funções usadas em handlers inline no HTML original — os únicos
  // handlers aceitos depois da sanitização.
  const allowed = new Set<string>();
  for (const m of html.matchAll(/\son[a-z]+\s*=\s*["']([^"']*)["']/gi)) {
    for (const call of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) allowed.add(call[1]);
  }

  const csp =
    "default-src 'none'; " +
    "script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com; " +
    "style-src 'unsafe-inline'; " +
    "font-src data:; " +
    "img-src data: blob:; " +
    "connect-src 'none'; " +
    "frame-src 'none'; child-src 'none'; object-src 'none'; " +
    "form-action 'none'; base-uri 'none'";

  const patch = `<meta http-equiv="Content-Security-Policy" content="${csp}">
<script>
(function () {
  var ALLOWED = new Set(${JSON.stringify([...allowed])});
  var BAD_TAGS = new Set(['SCRIPT','IFRAME','OBJECT','EMBED','LINK','META','BASE','FORM','FRAME','FRAMESET','APPLET','PORTAL']);
  var URL_ATTRS = ['href','src','action','xlink:href','poster','background'];
  var proto = Element.prototype;
  var nativeDesc = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
  var nativeSet = nativeDesc && nativeDesc.set;


  function cleanEl(el) {
    if (BAD_TAGS.has(el.tagName)) { el.remove(); return false; }
    var attrs = el.attributes;
    for (var i = attrs.length - 1; i >= 0; i--) {
      var name = attrs[i].name;
      var value = attrs[i].value || '';
      var lower = name.toLowerCase();
      if (lower === 'srcdoc' || lower === 'formaction' || lower.indexOf('data-on') === 0) {
        el.removeAttribute(name);
        continue;
      }
      if (lower.indexOf('on') === 0) {
        var calls = value.match(/([A-Za-z_$][\\w$]*)\\s*\\(/g) || [];
        var ok = calls.length > 0;
        for (var c = 0; c < calls.length; c++) {
          if (!ALLOWED.has(calls[c].replace(/\\s*\\($/, ''))) { ok = false; break; }
        }
        if (!ok) el.removeAttribute(name);
        continue;
      }
      if (URL_ATTRS.indexOf(lower) !== -1) {
        var v = value.replace(/[\\u0000-\\u0020]/g, '').toLowerCase();
        if (v.indexOf('javascript:') === 0 || v.indexOf('data:text/html') === 0 || v.indexOf('vbscript:') === 0) {
          el.removeAttribute(name);
        }
      }
    }
    return true;
  }

  function sanitizeFragment(root) {
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.isConnected && !root.contains(el)) continue;
      cleanEl(el);
    }
    return root;
  }

  function parse(htmlText) {
    var tpl = document.createElement('template');
    // usa o setter nativo para NÃO reentrar na nossa própria versão
    nativeSet.call(tpl, htmlText);
    sanitizeFragment(tpl.content);
    return tpl.content;
  }


  if (nativeDesc && nativeSet) {
    Object.defineProperty(proto, 'innerHTML', {
      configurable: true,
      enumerable: nativeDesc.enumerable,
      get: nativeDesc.get,
      set: function (value) {
        var text = value == null ? '' : String(value);
        if (text.indexOf('<') === -1) { nativeSet.call(this, text); return; }
        try {
          var frag = parse(text);
          while (this.firstChild) this.removeChild(this.firstChild);
          this.appendChild(frag);
        } catch (e) {
          nativeSet.call(this, text);
        }
      }
    });
  }

  var nativeInsert = proto.insertAdjacentHTML;
  proto.insertAdjacentHTML = function (position, value) {
    var text = value == null ? '' : String(value);
    try {
      var frag = parse(text);
      if (position === 'beforebegin') this.parentNode && this.parentNode.insertBefore(frag, this);
      else if (position === 'afterbegin') this.insertBefore(frag, this.firstChild);
      else if (position === 'beforeend') this.appendChild(frag);
      else if (position === 'afterend') this.parentNode && this.parentNode.insertBefore(frag, this.nextSibling);
    } catch (e) {
      nativeInsert.call(this, position, text);
    }
  };


  document.write = function () {};
  document.writeln = function () {};
})();
</script>`;

  return html.replace(/<head(\s[^>]*)?>/i, (m) => m + "\n" + patch);
}

function optimizeDashboardHtml(html: string): string {
  let out = hardenDashboardHtml(html);

  // Bridge progresso e erros para a UI wrapper (sem sobrescrever handleFile —
  // o HTML atual já usa leitura em streaming da aba Perda via file.slice()).
  out = out.replace(
    "function setProgress(pct, text, note) {",
    "function setProgress(pct, text, note) { window.dispatchEvent(new CustomEvent('pf-dashboard-progress', { detail: { pct, text: text || '', note: note || '' } }));",
  );
  out = out.replace(
    "function handleFileError(err) {",
    "function handleFileError(err) { window.dispatchEvent(new CustomEvent('pf-dashboard-error', { detail: { message: err && err.message ? err.message : String(err) } }));",
  );
  out = out.replace(
    "alert('Erro ao processar a aba de Perda: ' + err.message);",
    "window.dispatchEvent(new CustomEvent('pf-dashboard-error', { detail: { message: 'Erro ao processar a aba de Perda: ' + err.message } }));",
  );
  out = out.replace(
    "alert('Erro ao ler a aba de Perda: ' + err.message);",
    "window.dispatchEvent(new CustomEvent('pf-dashboard-error', { detail: { message: 'Erro ao ler a aba de Perda: ' + err.message } }));",
  );
  out = out.replace(
    "alert('Erro ao processar: ' + err.message);",
    "window.dispatchEvent(new CustomEvent('pf-dashboard-error', { detail: { message: 'Erro ao processar: ' + err.message } }));",
  );

  // Renomeia label "Via:" → "Local:" no topo
  out = out.replace(">Via:<", ">Local:<");

  // A aba antes chamada "CMV" agora se chama "Venda" no arquivo de dados.
  // O HTML original só reconhece o nome "cmv", então ampliamos os aliases.
  out = out.replace(/(CMV\s*:\s*)\[\s*(["'])cmv\2\s*\]/gi, "$1['venda','vendas','cmv']");

  // Substitui limparTodosFiltros para NÃO limpar Regional/Loja/Ciclo — só
  // Ano, Mês, Dia, Tipo, Local + os filtros da página Quebras/Vencidos.
  out = out.replace(
    /function limparTodosFiltros\(\)\s*\{[\s\S]*?renderDashboard\(\);\s*\}/,
    `function limparTodosFiltros() {
  ['anoFilter', 'mesFilter', 'diaFilter', 'tipoInvFilter', 'viaGlobalFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.disabled) el.value = '';
  });
  if (typeof selectedNaturezas !== 'undefined') selectedNaturezas.clear();
  if (typeof selectedVias !== 'undefined') selectedVias.clear();
  if (typeof selectedNaturezasDetalhadas !== 'undefined') selectedNaturezasDetalhadas.clear();
  if (typeof selectedStatusNatureza !== 'undefined') selectedStatusNatureza.clear();
  renderDashboard();
}`,
  );

  return out;
}

function dashboardHasExpectedContent(doc: Document): boolean {
  const dashboard = doc.getElementById("dashboard");
  if (!dashboard) return false;
  const text = dashboard.textContent?.replace(/\s+/g, " ") ?? "";
  return (
    /R\$\s*(?:de\s+)?Perda/i.test(text) &&
    /R\$\s*(?:de\s+)?Quebra/i.test(text) &&
    /Resultado Mês a Mês/i.test(text)
  );
}

function applyScope(
  profile: Profile,
  doc: Document,
  w: { renderDashboard?: () => void; lojaInfoMap?: Map<string, { regional?: string }> },
) {
  const isRegional = profile.role === "REGIONAL";
  const isLoja = profile.role === "LOJA";
  const canClearFilters = profile.role === "MASTER" || profile.role === "ADMIN";

  const hideFilterControl = (selectId: string) => {
    const sel = doc.getElementById(selectId) as HTMLSelectElement | null;
    if (!sel) return;
    // Estrutura: <label>...</label><select id="...">...</select> como irmãos
    // dentro de .filters-wrap. Escondemos APENAS o select e o label imediatamente
    // anterior — nunca o parentElement (que agrupa todos os filtros).
    const group = sel.closest(".filter-group, .filter-item") as HTMLElement | null;
    if (group && group !== sel.parentElement) {
      group.style.display = "none";
      return;
    }
    sel.style.display = "none";
    // Label associado por htmlFor
    const byFor = doc.querySelector<HTMLLabelElement>(`label[for="${selectId}"]`);
    if (byFor) byFor.style.display = "none";
    // Label irmão imediatamente anterior (sem for)
    let prev = sel.previousElementSibling as HTMLElement | null;
    while (prev && prev.nodeType === 1 && prev.tagName !== "LABEL" && prev.tagName !== "SELECT") {
      prev = prev.previousElementSibling as HTMLElement | null;
    }
    if (prev && prev.tagName === "LABEL") prev.style.display = "none";
    // Caso especial: lojaFilter tem label com id próprio
    if (selectId === "lojaFilter") {
      const lbl = doc.getElementById("lojaFilterLabel");
      if (lbl) (lbl as HTMLElement).style.display = "none";
    }
  };

  const hideImportControls = () => {
    // Oculta apenas o botão/link "Importar outro arquivo" e o painel de
    // "opções de mapeamento" — nunca o container inteiro (que também
    // abriga filtros como Ciclo/Mês/Dia/Tipo/Local).
    const candidates = doc.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], summary, label',
    );
    candidates.forEach((el) => {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) return;
      if (
        text.includes("importar outro arquivo") ||
        text.includes("opções de mapeamento") ||
        text.includes("opcoes de mapeamento")
      ) {
        el.style.display = "none";
      }
    });
  };

  const hideClearButton = () => {
    if (canClearFilters) return;
    const buttons = doc.querySelectorAll<HTMLElement>(
      'button, a, input[type="button"], input[type="submit"]',
    );
    buttons.forEach((btn) => {
      const onclick = btn.getAttribute("onclick") || "";
      const text = (btn.textContent || (btn as HTMLInputElement).value || "").trim().toLowerCase();
      if (onclick.includes("limparTodosFiltros") || /limpar\s+(todos\s+)?filtros?/i.test(text)) {
        btn.style.display = "none";
      }
    });
  };

  const hideEmailButton = () => {
    const buttons = doc.querySelectorAll<HTMLElement>(
      'button, a, input[type="button"], input[type="submit"], [role="button"]',
    );
    buttons.forEach((btn) => {
      const text = (btn.textContent || (btn as HTMLInputElement).value || "").trim().toLowerCase();
      if (
        (text.includes("enviar") && (text.includes("e-mail") || text.includes("email"))) ||
        text.includes("compartilhar") ||
        text.includes("exportar") ||
        text.includes("outlook")
      ) {
        btn.style.display = "none";
      }
    });
  };

  const hideGenerateFilesButton = () => {
    const buttons = doc.querySelectorAll<HTMLElement>(
      'button, a, input[type="button"], input[type="submit"], [role="button"], summary',
    );
    buttons.forEach((btn) => {
      const text = (btn.textContent || (btn as HTMLInputElement).value || "").trim().toLowerCase();
      const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const hasGenerate = /\bgerar\b/i.test(normalized);
      const hasFiles = /\barquivos?\b/i.test(normalized);
      const hasScope = /\b(lojas?|regiona(l|is)|escopo|distribuicao)\b/i.test(normalized);
      if (
        (hasGenerate && hasFiles) ||
        (hasGenerate && hasScope) ||
        text.includes("gerar arquivos")
      ) {
        btn.style.display = "none";
      }
    });
  };

  // Conjunto de lojas permitidas — recomputado a cada enforce porque o
  // dashboard preenche lojaInfoMap de forma assíncrona.
  const computeAllowedLojas = (): Set<string> => {
    const set = new Set<string>();
    if (isLoja && profile.scope_loja) {
      set.add(String(profile.scope_loja));
      return set;
    }
    if (isRegional && profile.scope_regional && w.lojaInfoMap) {
      const target = String(profile.scope_regional).trim().toLowerCase();
      for (const [loja, info] of w.lojaInfoMap.entries()) {
        const reg = info?.regional ? String(info.regional).trim().toLowerCase() : "";
        if (reg && reg === target) set.add(String(loja));
      }
    }
    return set;
  };

  const lockStyle = (el: HTMLSelectElement) => {
    el.disabled = true;
    el.style.opacity = "0.7";
    el.style.cursor = "not-allowed";
    el.setAttribute("data-pf-locked", "1");
  };

  // Aba "Recuperado": visível apenas para MASTER/ADMIN.
  const hideRecuperadoTab = () => {
    if (!isRegional && !isLoja) return;
    const tabs = doc.querySelectorAll<HTMLElement>(".view-tab, [onclick]");
    tabs.forEach((el) => {
      const onclick = el.getAttribute("onclick") || "";
      const text = (el.textContent || "").trim().toLowerCase();
      if (/switchView\(\s*['"]recuperado['"]/.test(onclick) || text.includes("recuperado")) {
        if (el.classList.contains("view-tab") || /switchView\(/.test(onclick)) {
          el.style.display = "none";
        }
      }
    });
    // Se a página Recuperado estiver ativa, volta para a primeira aba visível.
    const view = doc.getElementById("view-recuperado");
    if (view && view.classList.contains("active")) {
      const first = [...doc.querySelectorAll<HTMLElement>(".view-tab")].find(
        (t) => t.style.display !== "none",
      );
      first?.click();
    }
  };

  const enforce = () => {
    hideImportControls();
    hideEmailButton();
    hideGenerateFilesButton();
    hideClearButton();
    hideRecuperadoTab();

    // Ocultar filtros conforme hierarquia
    if (isRegional || isLoja) hideFilterControl("regionalFilter");
    if (isLoja) hideFilterControl("lojaFilter");

    if (!isRegional && !isLoja) return;

    const allowedLojas = computeAllowedLojas();
    // regionalFilter: manter apenas a regional do usuário
    const regSel = doc.getElementById("regionalFilter") as HTMLSelectElement | null;
    if (regSel && profile.scope_regional) {
      [...regSel.options].forEach((opt) => {
        if (opt.value !== "" && opt.value !== profile.scope_regional) opt.remove();
      });
      if (![...regSel.options].some((o) => o.value === profile.scope_regional)) {
        const opt = doc.createElement("option");
        opt.value = profile.scope_regional;
        opt.textContent = profile.scope_regional;
        regSel.appendChild(opt);
      }
      if (regSel.value !== profile.scope_regional) {
        regSel.value = profile.scope_regional;
        regSel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      lockStyle(regSel);
    }

    // lojaFilter: manter apenas lojas permitidas
    const lojaSel = doc.getElementById("lojaFilter") as HTMLSelectElement | null;
    if (lojaSel && allowedLojas.size > 0) {
      [...lojaSel.options].forEach((opt) => {
        if (opt.value === "") return;
        if (!allowedLojas.has(opt.value)) opt.remove();
      });
      if (isLoja && profile.scope_loja) {
        if (![...lojaSel.options].some((o) => o.value === profile.scope_loja)) {
          const opt = doc.createElement("option");
          opt.value = profile.scope_loja;
          opt.textContent = profile.scope_loja;
          lojaSel.appendChild(opt);
        }
        if (lojaSel.value !== profile.scope_loja) {
          lojaSel.value = profile.scope_loja;
          lojaSel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        lockStyle(lojaSel);
      }
    }

    // Histórico de Ciclos: remove linhas de lojas fora do escopo
    const tbody = doc.querySelector("#historicoCiclosTable tbody");
    if (tbody && allowedLojas.size > 0) {
      [...tbody.querySelectorAll("tr")].forEach((tr) => {
        const first = tr.querySelector("td");
        const loja = first?.textContent?.trim() ?? "";
        if (loja && !allowedLojas.has(loja)) tr.remove();
      });
    }
  };

  const target = doc.getElementById("dashboard") || doc.body;
  if (target) {
    const mo = new MutationObserver(() => enforce());
    mo.observe(target, { childList: true, subtree: true });
  }
  enforce();
  setTimeout(enforce, 400);
  setTimeout(enforce, 1200);

  if (typeof w.renderDashboard === "function") {
    setTimeout(() => w.renderDashboard!(), 500);
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case "MASTER":
      return "Master";
    case "ADMIN":
      return "Administrador";
    case "REGIONAL":
      return "Regional";
    case "LOJA":
      return "Loja";
    default:
      return role;
  }
}
