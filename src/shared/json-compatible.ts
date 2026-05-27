function formatJsonPath(root: string, path: readonly (string | number)[]): string {
  let current = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      current = `${current}[${segment}]`;
      continue;
    }
    current = current ? `${current}.${segment}` : segment;
  }
  return current || root || "value";
}

function describeNonJsonCompatibleValueAtPath(
  value: unknown,
  root: string,
  path: readonly (string | number)[],
  stack: WeakSet<object>,
): string | undefined {
  if (value === null) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `${formatJsonPath(root, path)} must be finite`;
  }
  if (typeof value !== "object") {
    return `${formatJsonPath(root, path)} must be JSON-compatible; got ${typeof value}`;
  }
  if (stack.has(value)) {
    return `${formatJsonPath(root, path)} must not contain circular references`;
  }

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const issue = describeNonJsonCompatibleValueAtPath(
          value[index],
          root,
          [...path, index],
          stack,
        );
        if (issue) {
          return issue;
        }
      }
      return undefined;
    }

    for (const [key, entry] of Object.entries(value)) {
      const issue = describeNonJsonCompatibleValueAtPath(entry, root, [...path, key], stack);
      if (issue) {
        return issue;
      }
    }
    return undefined;
  } finally {
    stack.delete(value);
  }
}

export function describeNonJsonCompatibleValue(value: unknown, root = "value"): string | undefined {
  return describeNonJsonCompatibleValueAtPath(value, root, [], new WeakSet());
}
