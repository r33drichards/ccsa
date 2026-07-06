---
name: picat
description: >-
  Write, run, and debug programs in Picat — the rule-based language that fuses
  logic programming, functional programming, constraint solving (cp/sat/smt/mip),
  tabling, and planning. Use this skill WHENEVER a task involves Picat code (a
  `.pi` file, `import cp`, pattern-matching rules with the arrow operators,
  `solve(Vars)`, `foreach` loops, `table` declarations, the `planner` module),
  AND whenever Picat is the right
  tool for a problem even if unnamed: constraint satisfaction/optimization
  (Sudoku, SEND+MORE, scheduling, packing), graph/path search, planning,
  dynamic-programming via tabling, or Prolog-style logic puzzles. Prefer this
  over hand-writing answers — Picat 3.9 runs in the tbjs sandbox, so you can
  actually execute and verify models. Triggers: "in Picat", "write a Picat
  program", "constraint model", "solve this puzzle", "Prolog-like", "planning
  problem", "tabled predicate".
---

# Picat

Picat is a general-purpose, rule-based language. The name encodes its features:
**P**attern-matching, **I**ntuitive (assignments/loops), **C**onstraints,
**A**ctors, **T**abling. Programs are sets of pattern-matching rules; a function
is a predicate that always succeeds with one answer.

This skill covers the language essentials needed to write correct Picat and the
exact mechanism for running it. For the deep reference (full built-in lists,
every constraint, I/O, modules, solver options), read
`references/language-reference.md`. The canonical source is the official guide
(split across many small continuation pages):
`https://picat-lang.org/download/picat_guide_html/picat_guide.html`.

## Running Picat (do this to verify any non-trivial program)

Picat 3.9 is bundled in the `tbjs:run_js` sandbox. Don't reason about output in
your head — run it. Bootstrap the engines at the top of **every** run (the
isolate is stateless) and bump the timeout, because the wasm engine has real
startup cost:

```js
(0, eval)(await fs.readFile('/opt/languages/bootstrap.js'));
const r = await picat(`
  import cp.
  main =>
    Vars = new_list(4), Vars :: 1..4,
    all_different(Vars),
    solve(Vars),
    println(Vars).
`);
console.log("stdout:", r.stdout.trim());
console.log("stderr:", r.stderr.trim(), "exit:", r.exitCode);
```

Set `execution_timeout_secs` to 120+ on these calls. `picat(code, args?)` returns
`{stdout, stderr, exitCode}`. `exitCode === 0` means success; on failure read
`stderr`. The program **must define `main/0`** (or `main/1` if you pass `args`);
print results with `println`/`printf`/`writeln`. Pass command-line args as the
second argument: `await picat(code, ["8"])` makes `main(Args)` run with
`Args = ["8"]` (a list of strings).

## Core syntax

### Rules

A predicate is defined by pattern-matching rules. Two kinds:

- **Non-backtrackable** (commits): `Head, Cond => Body.`
- **Backtrackable** (can retry on failure): `Head, Cond ?=> Body.`

`Cond` is optional. `=>` commits to the rule once head matches and `Cond`
succeeds. `?=>` leaves a choice point so backtracking can try later rules.

```picat
fib(0, F) => F = 1.
fib(1, F) => F = 1.
fib(N, F), N > 1 => fib(N-1, F1), fib(N-2, F2), F = F1 + F2.
fib(N, F) => throw $error(wrong_argument, fib, N).

member(X, [Y|_]) ?=> X = Y.        % nondeterministic: yields each element
member(X, [_|L])  => member(X, L).
```

Picat also supports **Prolog-style Horn clauses**: `Head :- Body.` (or just
`Head.` when the body is `true`).

### Functions

A function always succeeds with one return value. Head is an equation `f(...) = X`:

```picat
fib(0) = 1.
fib(1) = 1.
fib(N) = F, N > 1 => F = fib(N-1) + fib(N-2).

qsort([])    = [].
qsort([H|T]) = qsort([E : E in T, E =< H]) ++ [H] ++ qsort([E : E in T, E > H]).
```

A no-argument **function** call needs parentheses: `f()`. A no-argument
**predicate** call does not. Module-qualified functions are an exception:
`math.pi` (no parens).

### Data types

Primitive: integers (`12`, `0xf3`, `1.0e8`), reals, atoms (lowercase start, or
`'quoted'`). Compound: lists `[a,b,c]`, structures `$point(1.0, 2.0)`, arrays
`{a,b,c}`, maps, sets, heaps, strings (a string is a list of char atoms).

Critical gotcha — **the `$` on structures**: a bare `point(1,2)` is a *function
call*. To build it as *data*, write `$point(1,2)`. Picat allows function calls
inside arguments, so the `$` disambiguates.

Indexing is **1-based** and uses `X[I]`; a range `X[L..U]` returns a sublist.
Ranges: `1..5` -> `[1,2,3,4,5]`, `1..2..10` -> `[1,3,5,7,9]` (start..step..end).

Constructors: `new_list(N)`, `new_array(I1,...,In)`, `new_struct(Name, N)`,
`new_map(Pairs)`, `new_set(List)`. Maps: `put(M,K,V)`, `get(M,K)`,
`has_key(M,K)`. OOP/dot notation: `A.f(B)` is `f(A,B)`, and `X.put(k,v)` works.

### List & array comprehensions

```picat
L = [(A,I) : A in [a,b], I in 1..2]   % [(a,1),(a,2),(b,1),(b,2)]
Squares = [X*X : X in 1..5, X mod 2 == 1]
Arr = {X*X : X in 1..5}               % array comprehension uses { }
```

Form: `[Expr : Pattern in Domain, Condition, ...]`. Conditions filter.

### Assignments, if-else, loops

Bodies may use `:=` assignment (re-binds via fresh compile-time variables; undone
on backtracking). Index access `X[I] := V` updates in place.

```picat
test => X = 0, X := X+1, X := X+2, writeln(X).   % prints 3

classify(N) =>
    if N == 0 ; N == 1 then
        writeln(small)
    elseif N > 1 then
        writeln(big)
    else
        writeln(negative)
    end.
```

Loops — `foreach`, `while`, `do-while`. Variables that appear only inside a loop
(not before it) are **local to each iteration**:

```picat
sum_list(L) = Sum =>
    S = 0,
    foreach (X in L) S := S + X end,
    Sum = S.

% multiple iterators + condition:
foreach (I in 1..N, J in 1..N, I < J)
    printf("%w-%w%n", I, J)
end
```

`cond(Test, Then, Else)` is a conditional *expression*.

## Tabling (memoization, dynamic programming, loop prevention)

Add `table` before the first rule to memoize all calls/answers:

```picat
table
fib(0) = 1.
fib(1) = 1.
fib(N) = fib(N-1) + fib(N-2).   % exponential -> linear when tabled
```

**Mode-directed tabling** picks which answer to keep: `+` input, `-` output,
`min`/`max` optimize that argument, `nt` not tabled. Ideal for DP — e.g. true
Levenshtein edit distance (verified to return 3 for kitten→sitting):

```picat
table(+,+,min)
edit([],[],D) => D = 0.
edit([],[_|Ys],D) => edit([],Ys,D1), D = D1+1.                  % insert rest
edit([_|Xs],[],D) => edit(Xs,[],D1), D = D1+1.                  % delete rest
edit([X|Xs],[X|Ys],D) => edit(Xs,Ys,D).                         % match: cost 0
edit([X|Xs],[Y|Ys],D), X != Y ?=> edit(Xs,Ys,D1), D = D1+1.     % substitute
edit([X|Xs],[Y|Ys],D), X != Y ?=> edit(Xs,[Y|Ys],D1), D = D1+1. % delete X
edit([X|Xs],[Y|Ys],D), X != Y  => edit([X|Xs],Ys,D1), D = D1+1. % insert Y
```

## Constraint programming

Three steps: (1) make variables, (2) post constraints, (3) `solve`. Modules:
`cp` (default workhorse), `sat`, `smt`, `mip` — same interface, swap with the
`import`. Constraint operators start with `#`: `#=`, `#!=`, `#<`, `#>`, `#=<`,
`#>=`, and reified `#/\`, `#\/`, `#~`, `#=>`, `#<=>`. Inside arithmetic
constraints you do **not** need `$`.

```picat
import cp.
main =>
    Vars = [S,E,N,D,M,O,R,Y],
    Vars :: 0..9,
    all_different(Vars),
    S #!= 0, M #!= 0,
    1000*S + 100*E + 10*N + D + 1000*M + 100*O + 10*R + E
        #= 10000*M + 1000*O + 100*N + 10*E + Y,
    solve(Vars),
    println(Vars).
```

Domains: `X :: 1..9` or `X :: [1,3,5]`. Common global constraints:
`all_different/1`, `all_distinct/1`, `element/3`, `circuit/1`, `cumulative/4`,
`table_in/2`. Optimization: `solve([$min(Cost)], Vars)` or
`solve([$max(Profit)], Vars)`; options like `[ff]` (first-fail), `[degree]`,
`[split]`, `[down]` tune labeling. See the reference file for the full
constraint and option lists.

## Planning

`import planner`, define `final/1` (goal test) and `action/4`
(`action(State, NextState, Action, Cost)`), then call `plan/3-4` or
`best_plan/3-4`. The planner is tabling-backed and handles state-space search
efficiently.

**Trap (verified):** the planner calls `action` with `NextState`, `Action`, and
`Cost` *unbound*. Because Picat matching is one-way, head constants in those slots
never match — write **variable heads and bind the label/cost in the body**, or
the search silently finds nothing:

```picat
import planner.
main => best_plan(1, Plan, Cost), printf("%w cost %w%n", Plan, Cost).
final(12) => true.
action(S,S1,Action,Cost) ?=> Action = inc, Cost = 1, S1 = S+1, S1 =< 12.
action(S,S1,Action,Cost)  => Action = dbl, Cost = 1, S1 = S*2, S1 =< 12.
% => [inc,inc,dbl,dbl] cost 4
```

## Other essentials

- **Exceptions**: `throw Term`; catch with `catch(Goal, Pattern, Handler)`.
  Built-ins include `divide_by_zero`, `file_not_found`, `out_of_range`.
- **Modules**: a file starts with `module name.` (matching the filename) and
  optional `import m1, m2.`. `private` hides definitions. `basic`, `io`, `math`,
  `sys` are auto-imported.
- **Higher-order**: `call(S, Extra...)`, `apply(S, Extra...)` (returns a value),
  `findall(Template, Goal)`. Use recursion/loops/comprehensions instead where
  possible — higher-order calls have runtime-search overhead.
- **Negation/control**: `not Goal`, `once Goal` (first solution only),
  `Goal1 ; Goal2` disjunction, `fail`/`false`, `true`.

## Common mistakes to check

1. Forgot `main` — direct runs need `main/0` or `main/1`.
2. Bare structure where data was meant — add `$` (`$point(1,2)`).
3. No-arg function called without `()`.
4. Used `=` (unification) where you meant `#=` (a CP constraint), or vice versa.
5. 0-based indexing — Picat lists/structures are 1-based.
6. `==` vs `=`: `=` unifies; `==`/`!=` test term equality without binding;
   `=:=`/`=\=` test numeric equality.
7. One-way matching: a head *constant* (e.g. `action(S,S1,inc,1)`) won't match a
   *free variable* the caller passed. For predicates called in output mode, use
   variable heads and bind in the body, or write a Prolog-style `:-` clause.

When in doubt, **run the program** in the tbjs sandbox and read `stderr`.
