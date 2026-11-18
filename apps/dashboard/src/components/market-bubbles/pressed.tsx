import { cn } from "@workspace/ui/lib/utils"

// A row of buttons, one of them pressed.
export function Pressed<T extends string | number>({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onPick: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex overflow-hidden rounded-md border border-border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onPick(option.value)}
          className={cn(
            "border-border px-2.5 py-1.5 font-semibold not-first:border-l",
            option.value === value
              ? "bg-primary text-primary-foreground"
              : "bg-surface text-secondary-text hover:bg-elevated"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
