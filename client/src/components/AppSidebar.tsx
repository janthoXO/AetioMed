import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Plus,
  FileText,
  Stethoscope,
  Trash2,
  ScrollText,
  Moon,
  Sun,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useCases } from "@/hooks/useCases";
import { GenerateCaseModal } from "./GenerateCaseModal";
import { Spinner } from "./ui/spinner";
import { Switch } from "./ui/switch";
import { useTheme } from "@/context/ThemeProvider";

export function AppSidebar() {
  const { cases, isLoading, deleteCase } = useCases();
  const [modalOpen, setModalOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    await deleteCase(id);
    if (window.location.pathname.includes(id)) {
      navigate("/");
    }
  };

  return (
    <>
      <Sidebar>
        <SidebarHeader className="p-4">
          <div className="flex items-center gap-2">
            <Stethoscope className="h-6 w-6 text-primary" />
            <h1 className="text-lg font-semibold tracking-tight">AetioMed</h1>
          </div>
          <Separator className="my-2" />
          <Button
            onClick={() => setModalOpen(true)}
            className="w-full cursor-pointer"
            size="sm"
          >
            <Plus className="mr-2 h-4 w-4" />
            New Case
          </Button>
        </SidebarHeader>

        <SidebarContent>
          <ScrollArea className="flex-1">
            <SidebarGroup>
              <SidebarGroupLabel>Generated Cases</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-2">
                  {/* Loading skeletons on initial fetch */}
                  {isLoading &&
                    Array.from({ length: 5 }).map((_, i) => (
                      <SidebarMenuItem key={`skeleton-${i}`}>
                        <SidebarMenuSkeleton />
                      </SidebarMenuItem>
                    ))}

                  {/* Case list */}
                  {!isLoading &&
                    cases.map((c, index) =>
                      c.createdAt ? (
                        <ContextMenu key={c.id}>
                          <ContextMenuTrigger asChild>
                            <SidebarMenuItem>
                              <SidebarMenuButton asChild>
                                <NavLink
                                  to={`/cases/${c.id}`}
                                  className={({ isActive }) =>
                                    isActive ? "bg-sidebar-accent" : ""
                                  }
                                >
                                  <FileText className="shrink-0" />
                                  <div className="flex flex-col overflow-hidden">
                                    <span className="truncate text-sm font-medium">
                                      {c.diagnosis?.name ?? "Untitled Case"}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground">
                                      {c.diagnosis?.icd &&
                                        `${c.diagnosis.icd} · `}
                                      {new Date(
                                        c.createdAt
                                      ).toLocaleDateString()}
                                    </span>
                                  </div>
                                </NavLink>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-48">
                            <ContextMenuItem
                              onClick={() =>
                                navigate(`/cases/${c.id}/generating`)
                              }
                            >
                              <ScrollText className="mr-2 h-4 w-4" />
                              <span>View Traces</span>
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={(e) => handleDelete(e, c.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              <span>Delete Case</span>
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      ) : (
                        // Case is currently generating
                        <SidebarMenuItem key={`generating-${index}`}>
                          <SidebarMenuButton asChild>
                            <NavLink
                              to={`/cases/${c.id}/generating`}
                              className={({ isActive }) =>
                                isActive ? "bg-sidebar-accent" : ""
                              }
                            >
                              <Spinner className="shrink-0" />
                              <div className="flex flex-col overflow-hidden">
                                <span className="truncate text-sm font-medium">
                                  {c.diagnosis?.name ?? "Untitled Case"}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                  Generating...
                                </span>
                              </div>
                            </NavLink>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    )}

                  {/* Empty state */}
                  {!isLoading && cases.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No cases yet.
                      <br />
                      Click "New Case" to generate one.
                    </div>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </ScrollArea>
        </SidebarContent>

        <SidebarFooter className="p-4 flex flex-row ">
          <p className="text-xs text-muted-foreground text-center">
            AetioMed Case Generator
          </p>
          <Switch
            id="dark-mode-toggle"
            className="ml-auto"
            checked={theme === "dark"}
            onCheckedChange={() =>
              setTheme(theme === "dark" ? "light" : "dark")
            }
          >
            {theme === "dark" ? <Moon size={12} /> : <Sun size={12} />}
          </Switch>
        </SidebarFooter>
      </Sidebar>

      <GenerateCaseModal open={modalOpen} onOpenChange={setModalOpen} />
    </>
  );
}
