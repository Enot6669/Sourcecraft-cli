// SourceCraft Studio editor smoke-test fixture
export function greet(name = 'SourceCraft') {
  return `Привет, ${name}!`;
}

export function add(a, b) {
  return a + b;
}

// Expected: greet('Studio') => 'Привет, Studio!'
// Expected: add(2, 3) => 5
