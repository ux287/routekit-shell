import * as React from "react";
import { Button, Card, CardContent, CardHeader, Dialog, Input, Label, Separator, Tabs } from "@routekit/design";

export default function RoutekitDemo() {
  return (
    <div className="mx-auto max-w-5xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">RouteKit Design System Demo</h1>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Buttons</h2>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Inputs</h2>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" placeholder="you@example.com" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Tabs</h2>
        </CardHeader>
        <CardContent>
          <Tabs
            tabs={[
              { id: "one", label: "One", content: <div>Tab One</div> },
              { id: "two", label: "Two", content: <div>Tab Two</div> },
              { id: "three", label: "Three", content: <div>Tab Three</div> }
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Dialog</h2>
        </CardHeader>
        <CardContent>
          <Dialog trigger="Open Dialog" title="Sample Dialog">
            <p className="text-sm text-slate-700">Hello from RouteKit dialog.</p>
          </Dialog>
        </CardContent>
      </Card>

      <Separator />

      <p className="text-sm text-slate-600">Edit this page at <code>src/pages/routekit-demo.tsx</code></p>
    </div>
  );
}
