/** Encodes one Server-Sent Event frame, with an optional numeric id for Last-Event-ID resume. */
export function encodeSseEvent(type: string, data: unknown, id?: number): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${type}`);
  const json = JSON.stringify(data);
  for (const line of json.split('\n')) lines.push(`data: ${line}`);
  lines.push('', '');
  return lines.join('\n');
}

export function encodeSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}
