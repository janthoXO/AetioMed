import { Stethoscope, Plus, CalendarIcon, FileText } from "lucide-react";
import { useCases } from "@/hooks/useCases";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function HomePage() {
  const { cases, isLoading } = useCases();
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (cases.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6">
        <div className="rounded-full bg-primary/10 p-6">
          <Stethoscope className="h-12 w-12 text-primary" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">
            Welcome to AetioMed
          </h2>
          <p className="text-muted-foreground max-w-md">
            Generate medical cases powered by AI. Select an existing case from
            the sidebar or create a new one to get started.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Plus className="h-4 w-4" />
          <span>Click "New Case" in the sidebar to begin</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Recent Cases</h2>
        <p className="text-muted-foreground">
          Select an existing case or generate a new one.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cases.map((c) => (
          <Card
            key={c.id}
            className="cursor-pointer transition-colors hover:bg-muted/50"
            onClick={() => navigate(`/cases/${c.id}`)}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary shrink-0" />
                <span className="truncate">
                  {c.diagnosis?.name ?? "Untitled Case"}
                </span>
              </CardTitle>
              <CardDescription className="flex items-center gap-1.5 text-xs">
                <CalendarIcon className="h-3 w-3" />
                {new Date(c.createdAt).toLocaleDateString()}{" "}
                {new Date(c.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1">
                {c.generationFlags?.map((flag, idx) => (
                  <Badge key={idx} variant="secondary" className="text-xs">
                    {flag}
                  </Badge>
                ))}
                {(!c.generationFlags || c.generationFlags.length === 0) && (
                  <span className="text-xs text-muted-foreground">
                    No flags
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
