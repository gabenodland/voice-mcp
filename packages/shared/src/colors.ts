// Catppuccin Mocha color palette
export const C = {
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
  surface0: "#313244",
  surface1: "#45475a",
  surface2: "#585b70",
  overlay0: "#6c7086",
  overlay1: "#7f849c",
  overlay2: "#9399b2",
  subtext0: "#a6adc8",
  subtext1: "#bac2de",
  text: "#cdd6f4",
  lavender: "#b4befe",
  blue: "#89b4fa",
  sapphire: "#74c7ec",
  sky: "#89dceb",
  teal: "#94e2d5",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  peach: "#fab387",
  maroon: "#eba0ac",
  red: "#f38ba8",
  mauve: "#cba6f7",
  pink: "#f5c2e7",
  flamingo: "#f2cdcd",
  rosewater: "#f5e0dc",
} as const;

// High-contrast agent colors for visual differentiation
export const AGENT_COLORS = [
  "#89b4fa", // blue
  "#a6e3a1", // green
  "#fab387", // peach
  "#cba6f7", // mauve
  "#f9e2af", // yellow
  "#f38ba8", // red
  "#94e2d5", // teal
  "#f5c2e7", // pink
  "#74c7ec", // sapphire
  "#eba0ac", // maroon
  "#89dceb", // sky
  "#b4befe", // lavender
];

export function agentColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

export function timeAgo(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return `${Math.floor(days / 7)}w ago`;
}
