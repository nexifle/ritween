/** Keep headless canvas interop on the same Vulkan backend as WebGPU on Linux. */
export function browserArgs(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    "--enable-unsafe-webgpu",
    ...(platform === "linux"
      ? [
          "--use-angle=vulkan",
          "--enable-features=Vulkan",
          "--disable-vulkan-surface",
        ]
      : []),
  ];
}
