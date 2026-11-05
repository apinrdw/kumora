import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"

export const Route = createFileRoute("/")({ component: App })

function App() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="bg-[#020816] px-6 py-6">
        <img
          src="/kumora-wordmark.png"
          alt="KUMORA AI, follow the smart money"
          width={320}
          height={102}
          className="h-auto w-80 max-w-full"
        />
      </header>
      <div className="flex max-w-md min-w-0 flex-col gap-4 p-6 text-sm leading-loose">
        <div>
          <h1 className="font-medium">Project ready!</h1>
          <p>You may now add components and start building.</p>
          <p>We&apos;ve already added the button component for you.</p>
          <Button className="mt-2">Button</Button>
        </div>
      </div>
    </div>
  )
}
