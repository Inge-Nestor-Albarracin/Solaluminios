import type { ReactNode, SVGProps } from 'react'

// Thin line icons, in the style of the WeTracking app design.
function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  )
}

type P = SVGProps<SVGSVGElement>

export const IconHome = (p: P) => (
  <Icon {...p}><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z" /></Icon>
)
export const IconRegister = (p: P) => (
  <Icon {...p}><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></Icon>
)
export const IconScan = (p: P) => (
  <Icon {...p}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M7 12h10" /></Icon>
)
export const IconBulk = (p: P) => (
  <Icon {...p}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M8 9h8M8 12h8M8 15h5" /></Icon>
)
export const IconList = (p: P) => (
  <Icon {...p}><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></Icon>
)
export const IconChart = (p: P) => (
  <Icon {...p}><path d="M5 20V11M12 20V4M19 20v-6" /><path d="M3 20h18" /></Icon>
)
export const IconLogout = (p: P) => (
  <Icon {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 16l-4-4 4-4M6 12h10" /></Icon>
)
export const IconKey = (p: P) => (
  <Icon {...p}><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7M16 7l2.5 2.5M14 9l2 2" /></Icon>
)
export const IconArrow = (p: P) => (
  <Icon {...p}><path d="M4 12h15m-6-6 6 6-6 6" /></Icon>
)
export const IconSearch = (p: P) => (
  <Icon {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Icon>
)
export const IconFilter = (p: P) => (
  <Icon {...p}><path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5Z" /></Icon>
)
export const IconChevron = (p: P) => (
  <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>
)
export const IconTag = (p: P) => (
  <Icon {...p}><path d="M3 12V4h8l9 9-8 8-9-9Z" /><circle cx="7.5" cy="8.5" r="1.2" /></Icon>
)
export const IconPin = (p: P) => (
  <Icon {...p}><path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2.5" /></Icon>
)
export const IconCheck = (p: P) => (
  <Icon {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>
)
export const IconClose = (p: P) => (
  <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>
)
export const IconTasks = (p: P) => (
  <Icon {...p}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5" /></Icon>
)
export const IconClock = (p: P) => (
  <Icon {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Icon>
)
export const IconUser = (p: P) => (
  <Icon {...p}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c1.2-3.6 3.9-5.5 7-5.5s5.8 1.9 7 5.5" /></Icon>
)
export const IconSettings = (p: P) => (
  <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2" /><circle cx="12" cy="12" r="6.5" /></Icon>
)
