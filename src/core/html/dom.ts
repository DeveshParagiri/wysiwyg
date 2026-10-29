import type { AnyNode, Element } from "domhandler";

/**
 * Every node under `root`, in document order, without recursion.
 *
 * Use this instead of cheerio's `$("*").contents()`, which de-duplicates and
 * re-sorts the combined result with a document-position comparator: fine for
 * small pages, ~36 s on 80k elements — a denial-of-service vector.
 */
export function* descendants(root: AnyNode): Generator<AnyNode> {
  const stack: AnyNode[] = [...((root as Element).children ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    const children = (node as Element).children;
    if (children?.length) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}
