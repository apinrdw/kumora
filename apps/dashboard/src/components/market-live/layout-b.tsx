import { useEffect, useRef, type ReactNode } from "react"

// The gap kept under the layout, the page's bottom padding.
const BOTTOM_GAP = 16

// The element's minimum height runs from its top to the viewport's bottom,
// measured again on each resize, as `--fill`.
function useFillViewport<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const fit = () => {
      const top = element.getBoundingClientRect().top + window.scrollY
      element.style.setProperty(
        "--fill",
        `${Math.max(0, window.innerHeight - top - BOTTOM_GAP)}px`
      )
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [])
  return ref
}

/**
 * Layout B on desktop (spec apinrdw/kumora#263, "Layout, settings, indices
 * and phone"): the chart column, the 340 px sweep log and the 400 px right
 * column, at least as tall as the window below them; stacked below `lg`.
 */
export function LayoutB({
  charts,
  log,
  side,
}: {
  charts: ReactNode
  log: ReactNode
  side: ReactNode
}) {
  const layout = useFillViewport<HTMLDivElement>()
  return (
    <div
      ref={layout}
      className="grid gap-4 lg:min-h-(--fill) lg:grid-cols-[minmax(0,1fr)_340px_400px]"
    >
      <div className="flex min-w-0 flex-col gap-4">{charts}</div>
      {log}
      <div className="flex min-w-0 flex-col gap-4">{side}</div>
    </div>
  )
}
