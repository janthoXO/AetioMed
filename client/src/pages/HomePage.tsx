import { Stethoscope, Plus } from "lucide-react";

export default function HomePage() {
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
          Generate medical cases powered by AI. Select an existing case from the
          sidebar or create a new one to get started.
        </p>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Plus className="h-4 w-4" />
        <span>Click "New Case" in the sidebar to begin</span>
      </div>
    </div>
  );
}
