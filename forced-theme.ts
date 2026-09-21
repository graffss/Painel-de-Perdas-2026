/**
 * Tema forçado por usuário.
 *
 * O app é claro por padrão (tela de login e demais usuários). Apenas os e-mails
 * listados abaixo entram com o tema escuro ao logar. O tema é definido pela
 * classe `dark` no <html> (tokens em src/styles.css) e volta ao claro assim
 * que a sessão termina ou outro usuário entra.
 */

/** E-mails (minúsculos) que devem usar o tema escuro. */
export const FORCE_DARK_EMAILS: ReadonlySet<string> = new Set([
  "isac.santiago@promofarma.com.br",
]);

export function shouldForceDark(email: string | null | undefined): boolean {
  if (!email) return false;
  return FORCE_DARK_EMAILS.has(email.trim().toLowerCase());
}

/**
 * Sincroniza o tema da casca React com o usuário da sessão.
 * Sem e-mail (deslogado) = tema claro.
 */
export function syncThemeWithUser(email: string | null | undefined): boolean {
  const dark = shouldForceDark(email);
  if (typeof document === "undefined") return dark;
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "";
  return dark;
}

/**
 * Repassa o tema escuro ao documento do painel (iframe). Só age para quem tem
 * o tema forçado; para os demais o painel permanece exatamente como estava.
 * Não altera o HTML do painel: apenas marca a raiz do documento.
 */
export function applyThemeToPanelDocument(
  doc: Document | null | undefined,
  email: string | null | undefined,
): void {
  if (!doc || !shouldForceDark(email)) return;
  try {
    const root = doc.documentElement;
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
    root.style.colorScheme = "dark";
  } catch {
    /* documento do iframe indisponível: ignora */
  }
}
