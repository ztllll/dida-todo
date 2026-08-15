import { stripManagedContent } from "./codec.js";
import type { WorkMetadata } from "./domain.js";
import { migrateWorkMetadata } from "./work-lifecycle.js";

const LEGACY_PROGRESS_BLOCK = /(?:^|\n\n)当前进展：[^\n]*\n已处理 \d+\/\d+ 项(?=\n\n|$)/g;

export function originalHumanDescription(
  metadata: WorkMetadata,
  userContent: string,
  remoteDescription?: string,
): string {
  const migrated = migrateWorkMetadata(metadata);
  const content = userContent.trim();
  const source = migrated.userDescription
    ?? stripManagedContent(remoteDescription).replace(LEGACY_PROGRESS_BLOCK, "");
  let description = source.trim();
  if (content) {
    const appendedContent = `\n\n${content}`;
    while (description.endsWith(appendedContent)) {
      description = description.slice(0, -appendedContent.length).trimEnd();
    }
    if (description === content) description = "";
  }
  return description;
}

export function composeHumanWorkDescription(
  metadata: WorkMetadata,
  userContent: string,
  remoteDescription?: string,
): string {
  const description = originalHumanDescription(metadata, userContent, remoteDescription);
  const content = userContent.trim();
  return [description, content].filter(Boolean).join("\n\n");
}
