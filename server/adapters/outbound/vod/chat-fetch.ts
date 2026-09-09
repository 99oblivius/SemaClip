/**
 * GQL chat fetcher (progressive download part 1) — downloads VOD comments
 * page-by-page into the TwitchDownloader-shaped JSON the existing chat
 * parser consumes. Schema-verified live: `comments` takes ONLY
 * contentOffsetSeconds (Int — the Float the Phase 1 script used now errors);
 * message text arrives via fragments; pagination is offset-based
 * (offset = last offset + 1, edges deduped on overlap).
 */

const GQL_URL = "https://gql.twitch.tv/gql";
const CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

export interface RawComment {
  t: number;
  user: string;
  body: string;
}

async function gql(body: unknown, tries = 5): Promise<Record<string, unknown>> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(GQL_URL, {
        method: "POST",
        headers: { "Client-ID": CLIENT_ID, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`GQL ${res.status}`);
      return await res.json() as Record<string, unknown>;
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

interface CommentEdge {
  node: {
    contentOffsetSeconds: number;
    commenter: { displayName: string };
    message: { fragments: ({ text: string; emote: { id: string } | null } | null)[] | null };
  };
}

const COMMENTS_QUERY =
  "query VideoCommentsByOffsetOrCursor($videoID: ID!, $contentOffsetSeconds: Int) {"
  + " video(id: $videoID) { comments(contentOffsetSeconds: $contentOffsetSeconds) {"
  + " edges { node { contentOffsetSeconds commenter { displayName } message { fragments { text emote { id } } } } }"
  + " pageInfo { hasNextPage } } } }";

/**
 * Fetches all comments for a VOD by offset pagination (offset = last
 * returned offset + 1; the schema takes no cursor argument — edges carry
 * cursors but `comments(cursor:)` errors). Message text arrives via
 * fragments (joined); emote-only detection is left to the parser's
 * fragment-aware fields (bits/emote flags default harmlessly here).
 * Reports progress per page (~60 comments/page at dense chat).
 * Writes TwitchDownloader-compatible JSON (comments[] with
 * content_offset_seconds/commenter.display_name/message.body) to destPath.
 * Returns the comment count.
 */
export async function downloadChat(
  vodId: string,
  destPath: string,
  opts: {
    onProgress: (p: { comments: number; pages: number }) => void;
    signal?: AbortSignal | undefined;
  },
): Promise<number> {
  const out: RawComment[] = [];
  const seenTs = new Set<number>();
  let offset: number | null = 0;
  let page = 0;
  let hasNext = true;

  while (hasNext && offset !== null) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const d = await gql({
      operationName: "VideoCommentsByOffsetOrCursor",
      query: COMMENTS_QUERY,
      variables: { videoID: vodId, contentOffsetSeconds: offset },
    }) as {
      data?: {
        video?: {
          comments?: {
            edges?: {
              node: {
                contentOffsetSeconds: number;
                commenter: { displayName: string };
                message: { fragments: ({ text: string; emote: { id: string } | null } | null)[] | null };
              };
            }[] | null;
            pageInfo?: { hasNextPage?: boolean | null } | null;
          } | null;
        } | null;
      };
    };
    const vc = d.data?.video?.comments;
    const edges = vc?.edges ?? [];
    if (edges.length === 0) break;
    for (const e of edges) {
      const n = e.node;
      if (typeof n.contentOffsetSeconds !== "number") continue;
      const key = n.contentOffsetSeconds;
      if (seenTs.has(key)) continue; // overlap between offset pages
      seenTs.add(key);
      const text = (n.message?.fragments ?? [])
        .map((f) => f?.text ?? "")
        .join("")
        .trim();
      if (!text) continue;
      out.push({ t: n.contentOffsetSeconds, user: n.commenter?.displayName ?? "unknown", body: text });
    }
    const last = edges[edges.length - 1];
    if (!last) break;
    offset = Math.floor(last.node.contentOffsetSeconds) + 1;
    page++;
    hasNext = vc?.pageInfo?.hasNextPage ?? false;
    opts.onProgress({ comments: out.length, pages: page });
    if (!hasNext) break;
  }

  out.sort((a, b) => a.t - b.t);
  const doc = {
    comments: out.map((c) => ({
      content_offset_seconds: c.t,
      commenter: { display_name: c.user },
      message: { body: c.body },
    })),
  };
  await Deno.writeTextFile(destPath, JSON.stringify(doc));
  return out.length;
}