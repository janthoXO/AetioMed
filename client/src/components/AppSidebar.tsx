import { NavLink, useNavigate } from "react-router-dom";
import {
  Plus,
  FileText,
  Stethoscope,
  Trash2,
  Moon,
  Sun,
  PanelLeftClose,
  PanelRightClose,
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
  useSidebar,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useCases } from "@/hooks/useCases";
import { GenerateCaseModal } from "./GenerateCaseModal";
import { Spinner } from "./ui/spinner";
import { Switch } from "./ui/switch";
import { useTheme } from "@/context/ThemeProvider";
import { useState } from "react";

export function AppSidebar() {
  const { cases, isLoading, deleteCase } = useCases();
  const [modalOpen, setModalOpen] = useState(false);
  const [caseToDelete, setCaseToDelete] = useState<number | null>(null);
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";

  const handleDelete = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    e.preventDefault();
    setCaseToDelete(id);
  };

  const confirmDelete = async () => {
    if (caseToDelete === null) return;
    await deleteCase(caseToDelete);
    if (window.location.pathname.includes(caseToDelete.toString())) {
      navigate("/");
    }
    setCaseToDelete(null);
  };

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader
          className={isCollapsed ? "p-2 items-center flex-col gap-4" : "p-4"}
        >
          <div
            className={`flex w-full ${isCollapsed ? "flex-col items-center gap-4" : "items-center justify-between"}`}
          >
            <Button
              variant="ghost"
              onClick={() => navigate("/")}
              className={`flex items-center gap-2 hover:opacity-80 transition-opacity ${isCollapsed ? "justify-center" : ""}`}
              title="Go to homepage"
            >
              <Stethoscope className="h-6 w-6 text-primary shrink-0" />
              {!isCollapsed && (
                <h1 className="text-lg font-semibold tracking-tight">
                  AetioMed
                </h1>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
              className={isCollapsed ? "" : "-mr-2"}
            >
              {isCollapsed ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </Button>
          </div>
          {!isCollapsed && <Separator className="my-2" />}
          <Button
            onClick={() => setModalOpen(true)}
            className={`w-full cursor-pointer ${isCollapsed ? "h-6 w-6 p-0 rounded-md flex items-center justify-center shrink-0" : ""}`}
            size={isCollapsed ? "icon" : "sm"}
            title="New Case"
          >
            {isCollapsed ? (
              <Plus className="h-3 w-3" />
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                New Case
              </>
            )}
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
                    cases.map((c) => {
                      const isGenerating =
                        c.runs && c.runs.some((r) => r.status === "generating");
                      return (
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
                                  {isGenerating ? (
                                    <Spinner className="shrink-0" />
                                  ) : isCollapsed ? (
                                    <span className="shrink-0 flex items-center justify-center font-semibold w-4 h-4">
                                      {(
                                        c.diagnosis?.name?.[0] ?? "U"
                                      ).toUpperCase()}
                                    </span>
                                  ) : (
                                    <FileText className="shrink-0" />
                                  )}
                                  <div className="flex flex-col overflow-hidden">
                                    <span className="truncate text-sm font-medium">
                                      {c.diagnosis?.name ?? "Untitled Case"}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground">
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
                              onClick={(e) => handleDelete(e, c.id!)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              <span>Delete Case</span>
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}

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

        <SidebarFooter
          className={`p-4 flex ${isCollapsed ? "flex-col items-center justify-center gap-4 border-t-0 p-2" : "flex-row items-center"} `}
        >
          {!isCollapsed && (
            <p className="text-xs text-muted-foreground text-center">
              AetioMed Case Generator
            </p>
          )}
          <Switch
            id="dark-mode-toggle"
            className={isCollapsed ? "" : "ml-auto"}
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

      <Dialog
        open={caseToDelete !== null}
        onOpenChange={(open) => !open && setCaseToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Case</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this case? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCaseToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
