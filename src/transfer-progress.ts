export function progressReporter(write: (text: string) => void, now = Date.now) {
  const started = now();
  let previousStage = "";
  let previousTime = -Infinity;
  let previousBytes = -1;
  return (progress: { stage: string; bytes: number; total: number }) => {
    const time = now();
    if (progress.stage === previousStage && progress.bytes === previousBytes) return;
    if (progress.stage === previousStage && progress.bytes !== 0 && progress.bytes !== progress.total && time - previousTime < 1000) return;
    previousStage = progress.stage; previousTime = time; previousBytes = progress.bytes;
    // Only fixed stages and byte counts; filenames/credentials never enter progress output.
    const stage = ["preparing", "uploading", "finalizing", "verifying", "downloading"].includes(progress.stage) ? progress.stage : "working";
    write(`${stage}: ${progress.bytes}/${progress.total} bytes (${Math.floor((time - started) / 1000)}s)\n`);
  };
}
