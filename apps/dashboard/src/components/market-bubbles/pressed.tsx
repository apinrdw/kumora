import { cn } from "@workspace/ui/lib/utils"

// A row of buttons, one of them pressed; a disabled option can't be pressed.
export function Pressed<T extends string | number>({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>
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
          disabled={option.disabled}
          onClick={() => onPick(option.value)}
          className={cn(
            "border-border px-2.5 py-1.5 font-semibold not-first:border-l disabled:cursor-not-allowed disabled:opacity-50",
            option.value === value
              ? "bg-primary text-primary-foreground"
              : "bg-surface text-secondary-text enabled:hover:bg-elevated"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
