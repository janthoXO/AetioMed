import { useState } from "react";
import { NavLink } from "react-router-dom";
import { Plus, FileText, Stethoscope } from "lucide-react";
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
import { useCases } from "@/hooks/useCases";
import { GenerateCaseModal } from "./GenerateCaseModal";

export function AppSidebar() {
  const { cases, isLoading } = useCases();
  const [modalOpen, setModalOpen] = useState(false);

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
                      c.id == null ? (
                        // No id = still generating — custom skeleton matching case item layout
                        <SidebarMenuItem key={`generating-${index}`}>
                          <SidebarMenuSkeleton />
                        </SidebarMenuItem>
                      ) : (
                        <SidebarMenuItem key={c.id}>
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
                                  {c.diagnosis?.icd && `${c.diagnosis.icd} · `}
                                  {new Date(c.createdAt).toLocaleDateString()}
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

        <SidebarFooter className="p-4">
          <p className="text-xs text-muted-foreground text-center">
            AetioMed Case Generator
          </p>
        </SidebarFooter>
      </Sidebar>

      <GenerateCaseModal open={modalOpen} onOpenChange={setModalOpen} />
    </>
  );
}
