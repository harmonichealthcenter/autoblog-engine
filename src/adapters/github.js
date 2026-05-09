// GitHub Contents API publish adapter.
// Commits a markdown file to a target repo at the configured path.
// No local clone required.

export async function commitFile({ token, repo, branch = "main", path: filePath, content, message }) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "autoblog-engine",
  };

  // Check if file exists (need its sha to update)
  let sha;
  const head = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
  if (head.status === 200) {
    sha = (await head.json()).sha;
  } else if (head.status !== 404) {
    throw new Error(`GitHub HEAD ${head.status}: ${await head.text()}`);
  }

  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  };

  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    commit_sha: json.commit?.sha,
    html_url: json.content?.html_url,
    path: json.content?.path,
  };
}
