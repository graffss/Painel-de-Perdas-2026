import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { syncThemeWithUser } from "@/lib/forced-theme";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      syncThemeWithUser(null);
      throw redirect({ to: "/auth" });
    }
    // Aplica o tema antes de renderizar a página, evitando piscar claro → escuro.
    syncThemeWithUser(data.user.email);
    const { data: profile } = await supabase
      .from("users_profiles")
      .select("id,email,role,status,scope_via,scope_regional,scope_loja,must_change_password,data_file")
      .eq("id", data.user.id)
      .maybeSingle();
    if (!profile) throw redirect({ to: "/pending" });
    if (profile.status !== "APPROVED") throw redirect({ to: "/pending" });
    if (profile.must_change_password) throw redirect({ to: "/change-password" });
    return { profile };
  },
  component: () => <Outlet />,
});
