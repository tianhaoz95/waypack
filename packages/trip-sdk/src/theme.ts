/** Category → color/emoji. Templates may use these for consistent styling. */
export const categories: Record<string, { color: string; emoji: string; label: string }> = {
  lodging: { color: "#7c3aed", emoji: "🛏️", label: "Lodging" },
  food: { color: "#ea580c", emoji: "🍴", label: "Food" },
  sight: { color: "#0891b2", emoji: "📷", label: "Sight" },
  activity: { color: "#16a34a", emoji: "⭐", label: "Activity" },
  trailhead: { color: "#15803d", emoji: "🥾", label: "Trailhead" },
  transport: { color: "#2563eb", emoji: "🚌", label: "Transport" },
  fuel: { color: "#ca8a04", emoji: "⛽", label: "Fuel" },
  shopping: { color: "#db2777", emoji: "🛒", label: "Shopping" },
  medical: { color: "#dc2626", emoji: "🏥", label: "Medical" },
  other: { color: "#64748b", emoji: "📍", label: "Other" },
};

export const routeModes: Record<string, { color: string; dash?: number[]; label: string }> = {
  driving: { color: "#2563eb", label: "Drive" },
  walking: { color: "#db2777", dash: [1, 1.5], label: "Walk" },
  hiking: { color: "#c2410c", dash: [2, 1.5], label: "Hike" },
  cycling: { color: "#16a34a", dash: [3, 1], label: "Cycle" },
  transit: { color: "#7c3aed", label: "Transit" },
  ferry: { color: "#0891b2", dash: [3, 2], label: "Ferry" },
  flight: { color: "#64748b", dash: [4, 3], label: "Flight" },
};
