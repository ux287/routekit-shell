import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";

export function Contact() {
  return (
    <main className="space-y-6">
      <h1 className="text-4xl font-semibold">Contact</h1>
      <form className="space-y-4">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" placeholder="Jane Doe" />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" placeholder="you@example.com" type="email" />
        </div>
        <Button type="submit">Send Brief</Button>
      </form>
    </main>
  );
}
