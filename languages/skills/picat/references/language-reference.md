# Picat Language Reference

Condensed reference derived from *A User's Guide to Picat* v3.9 (Neng-Fa Zhou &
Jonathan Fruhman). Consult the official multi-page guide for exhaustive detail:
`https://picat-lang.org/download/picat_guide_html/picat_guide.html`.

## Table of contents
1. Data types & terms
2. Equality, unification, comparison
3. Operators (precedence summary)
4. Predicates, functions, pattern-matching
5. Assignments, control, loops, comprehensions
6. Exceptions
7. Tabling
8. The `planner` module
9. Modules & visibility
10. I/O
11. Action rules & actors
12. Constraints (cp/sat/smt/mip)
13. Solver invocation & options
14. Library modules (math, os, sys, util, ordset, datetime, nn)
15. Running programs / interpreter / debugger

---

## 1. Data types & terms

A *value* is primitive or compound. Primitive: integer, real, atom (a single
char is a one-char atom). Compound: list `[t1,...,tn]`, structure
`$s(t1,...,tn)` (arity n, name s). Strings, arrays, maps, sets, heaps are
special compound values.

- **Variables**: identifier starting with uppercase or `_`. `_` alone is
  anonymous. Free until bound. *Attributed variables* carry a map of attribute
  pairs (`put_attr(X,Key,Val)` / `get_attr(X,Key)`).
- **Atoms**: lowercase start, or `'single quoted'`. Globally visible; belong to
  no module.
- **Numbers**: `12`, `0xf3` (hex), `0o17` (octal), `0b101` (binary), `1.0e8`.
- **Lists**: `[H|T]` cons. A string is a list of char atoms; `"abc" ++ "de"`
  concatenates.
- **Arrays**: `{a,b,c}` — a structure named `'{}'`. `new_array(2,3)` is 2-D.
- **Maps/sets**: hash tables. `new_map([k1=v1,...])`, `new_set([e1,...])`. A set
  maps every key to `not_a_value`.
- **Heaps**: complete binary trees stored as arrays; min- or max-heaps.

Index notation `X[I]` (1-based) returns one element; `X[L..U]` a sublist. Index
expressions must be integers/ranges — arithmetic operators are not overloaded.

`new_struct(Name, IntOrList)`, `name(S)`, `length(S)`, `arity(S)`, `to_array/1`,
`to_list/1` convert/inspect.

## 2. Equality, unification, comparison

- `X = Y` — unification (binds variables).
- `X == Y` / `X !== Y` (also `!=`) — term identity/equality, no binding.
- `X =:= Y` / `X =\= Y` — numerical equality / inequality (evaluate both sides).
- `compare(Order, X, Y)`, `@<`, `@=<`, `@>`, `@>=` — standard order of terms:
  Var < number < atom < string < structure (then by arity, name, args).

## 3. Operators (precedence summary, high→low binds tighter listed lower)

Key ones (left-assoc unless noted): `:-` `=>` `?=>` (rule); `;` `||` (disjunction);
`,` `&&` (conjunction); `not` `once`; comparison/constraint `#= #!= #< #> #=< #>=
= != == !== =:= =\= < > =< >= in notin ::`; `..`; `++` (list/string concat);
`+ -`; `* / // mod rem div`; `**` `^` (power, right-assoc); unary `- + \ #~`;
`@` (as-pattern); `.` and `[]` (highest). `#/\ #\/ #=> #<=>` are reified
constraint connectives. **You cannot define or redefine operators.**

## 4. Predicates, functions, pattern-matching

Rule forms: `Head, Cond => Body.` (commit) and `Head, Cond ?=> Body.`
(backtrackable). Horn clauses `Head :- Body.` compile to `?=>` rules with `$`-
quoted head args. A predicate may have an `index (+,-)(-,+)...` declaration
(Horn-clause / fact predicates) to choose which argument combos get indexed —
affects efficiency only. Function *facts*: `f(a) = 1.` auto-indexed on inputs.

Patterns: `[H|T]`, `{A,B}`, `$s(X,Y)`, literals, `_`, and as-patterns
`X@[H|_]` (bind whole term and destructure). A rule is applicable when the head
matches and `Cond` succeeds.

**Matching is one-way, not unification (the #1 Picat surprise).** In `=>`/`?=>`
rules, head variables get bound to the caller's arguments, but a head
*non-variable* (a constant like `inc`, `0`, or a structure) matches only if the
caller already supplied that value. A *free variable in the call* will NOT be
bound to a head constant — the rule simply fails to match. So a predicate you
intend to call in "output mode" (caller passes unbound vars expecting them
filled in) must use **variable heads and bind the constants in the body**:

```picat
% WRONG when called as gen(X) with X free — head constant 1 can't match a var:
gen(1) => true.
% RIGHT — variable head, bind in body:
gen(X) => X = 1.
```

Prolog-style Horn clauses (`Head :- Body.`) sidestep this: they compile to a rule
whose head args are unified in the body, so they behave relationally like Prolog.
Use `:-` clauses (or variable-head `=>` rules) for relations meant to run
backwards. This is exactly why the `planner` module's `action`/`final` must be
written with variable heads (see §8).

`true`, `fail`/`false`. A function call never fails and never succeeds twice;
bad input should `throw`. Tail-recursive rules are optimized; loops compile to
tail-recursive predicates.

## 5. Assignments, control, loops, comprehensions

- Assignment `LHS := RHS` where LHS is a var or `X[I]`; backtracking undoes it.
- `if Cond then Goal (elseif Cond then Goal)* (else Goal)? end`. Omitted `else`
  is `else true`. Inline `(Cond -> Then ; Else)` also works.
- `foreach (E1 in D1, Cond1, ..., En in Dn, Condn) Goal end`.
- `while (Cond) Goal end` and `do Goal while (Cond)`.
- List comprehension `[T : E1 in D1, Cond1, ...]`; array comprehension
  `{T : ...}` = `to_array([...])`. Loop bodies form a name scope: vars used only
  inside are per-iteration local.

## 6. Exceptions

`throw E` raises term E. `catch(Goal, Catcher, Handler)` runs Handler (after
undoing Goal's bindings) when a matching exception fires. `call_cleanup(Goal,
Cleanup)` runs Cleanup when Goal exits determinately, fails, or throws. Common
system exceptions: `divide_by_zero`, `file_not_found`, `number_expected`,
`out_of_range`, `interrupt(keyboard)` (ctrl-c).

## 7. Tabling

`table` before the first rule memoizes calls/answers — prevents infinite loops
and redundancy. **Mode-directed**: `table(M1,...,Mn)` where each mode is `+`
(input), `-` (output), `min`, `max` (optimize), or `nt` (not tabled). At most one
`min`/`max` typically; great for DP (edit distance, knapsack, longest path). A
tabled predicate may also carry an `index` declaration if it has facts.

## 8. The `planner` module

`import planner`. Define the goal test `final(State)` and transitions
`action(State, NextState, Action, Cost)`. Search:
- `plan(State, Plan)`, `plan(State, Plan, Cost)`, `plan(State, Limit, Plan, Cost)`
  — depth-bounded (`Limit` bounds the cost; without enough limit it returns
  failure, i.e. "no plan").
- `best_plan(State, Plan)` / `best_plan(State, Plan, Cost)` — minimal cost
  (depth-unbounded via iterative deepening + tabling).
- Branch-and-bound / unbounded variants also exist (e.g. `best_plan_unbounded`,
  `best_plan_bb`); check the guide before relying on a specific name.
States must be ground and hashable; the planner tables visited states.

**Write `action`/`final` with VARIABLE heads and bind `Action`/`Cost` in the
body.** The planner calls `action(State, NextState, Action, Cost)` with the last
three arguments *unbound*. Because Picat matching is one-way (§4), a head with
constants in those positions never matches, so `action` silently fails — giving a
spurious "no plan" from `plan`, or an endless search from `best_plan`. (Verified
in the tbjs sandbox.) Use guards to keep moves legal and bound the state space.

```picat
import planner.

main =>
    best_plan(1, Plan, Cost),            % reach 12 from 1 via +1 / x2, min steps
    printf("plan = %w, cost = %w%n", Plan, Cost).

final(12) => true.                       % goal test (variable would also be fine)

action(S, S1, Action, Cost) ?=>          % +1 move: bind label & cost in BODY
    Action = inc, Cost = 1,
    S1 = S + 1, S1 =< 12.
action(S, S1, Action, Cost) =>           % x2 move
    Action = dbl, Cost = 1,
    S1 = S * 2, S1 =< 12.
% => prints: plan = [inc,inc,dbl,dbl], cost = 4
```

## 9. Modules & visibility

File `name.pi` may begin `module name.` then `import a, b.` No module
declaration => belongs to the global module (visible everywhere). Definitions are
public unless preceded by `private`. Qualify with `m.p(...)` (module still must
be imported). Call-resolution order for a non-higher-order call: implicit
built-ins (`basic`, `math`, `io`, `sys`), enclosing module, explicitly imported
modules (import order), global module. `cl(File)` compiles+loads; `compile`,
`load`, `include Name.` (verbatim source inclusion).

## 10. I/O

`open(Name, Mode)` (`read`/`write`/`append`) returns a stream; `read_*` family
(`read_int`, `read_real`, `read_line`, `read_term`, `read_char`), EOF gives
`end_of_file`. Write: `print/1`, `println/1`, `write/1`, `writeln/1`,
`print(Stream, X)`, `nl`. Formatted: `printf`/`writef` with `%w` (term),
`%s` (string), `%d`, `%5.2f`, `%n` (newline). `flush`, `close`. Standard streams:
`stdin`, `stdout`, `stderr`.

## 11. Action rules & actors

`Head, Cond, {Event} => Body.` defines event-driven actors (no backtrackable
rules allowed). Channels are attributed vars with ports `ins`, `bound`, `dom`,
`any`. Events: `ins(X)` fires on instantiation; `event(X,T)` on posted term.
`post_event(X,T)` posts to the dom-port. `freeze/2` and constraint propagators
are built on action rules.

## 12. Constraints (cp / sat / smt / mip)

Workflow: declare vars + domains, post constraints, `solve`. `import cp` (or
`sat`, `smt`, `mip` — identical interface). Domain: `X :: 1..9`, `Vs :: [1,3,5]`,
`Vs :: 0..9` (list of vars). Inside `#`-constraints, expressions are data (no `$`).

Arithmetic/relational (reifiable): `#=`, `#!=`, `#<`, `#>`, `#=<`, `#>=`.
Boolean/logical: `#/\` (and), `#\/` (or), `#~` (not), `#=>` (imply), `#<=>`
(iff). Also `B :: 0..1` booleans; `sum/1`, `count/4`, `min/1`, `max/1`,
`abs/1`, `**`, etc. usable in constraint expressions.

Global constraints (subset): `all_different(L)`, `all_distinct(L)` (stronger
propagation), `element(I, L, V)`, `nvalue/2`, `circuit(L)`, `subcircuit(L)`,
`cumulative(Starts, Durations, Resources, Limit)`, `disjunctive/2`,
`diffn/1`, `serialized/2`, `assignment/2`, `lex_le/2`, `lex_lt/2`,
`global_cardinality(L, Pairs)`, `table_in(Tuple, Relation)`,
`table_notin/2`, `regular/...`, `neqs/1`. (sat/mip support subsets.)

Bit-vector constraints (sat only): operate on lists of 0/1 vars for bitwise
modeling.

## 13. Solver invocation & options

`solve(Vars)`, `solve(Options, Vars)`. Optimization objective inside Options:
`$min(Expr)`, `$max(Expr)`. Also `solve_all/1-2` (all solutions), `solve_suspended`.

Common options: variable selection `[ff]` (first-fail / smallest domain),
`[ffc]`, `[degree]`, `[max]`, `[min]`, `[leftmost]`, `[occurrence]`; value
choice `[up]`/`[down]`, `[split]`, `[reverse_split]`; plus `[report]`,
`[$report(Goal)]`, `[backtrack(N)]`, `[timeout(Ms)]`, `[seed(N)]`. cp-specific,
sat-specific (e.g. solver backend selection), mip-specific (LP relaxation),
smt-specific options exist — see guide §12.7. With `mip`, vars may be real;
with `sat`, everything is bit-blasted to a SAT solver (Kissat).

## 14. Library modules

- **math**: constants `pi`, `e`; `abs`, `sign`, `min/max`, `gcd`, `floor`,
  `ceiling`, `round`, `truncate`, `sqrt`, `pow`/`**`, `exp`, `log`, `log2`,
  `log10`, `to_radians`/`to_degrees`, trig (`sin`,`cos`,`tan`,`asin`,…), hyper
  (`sinh`,…), `random`/`random2`/`frand`, `prime`, `factorial`.
- **os**: `Path` parameter, directory ops, `cwd`/`chdir`, create/delete files &
  dirs, `exists`, file info (size/time), `getenv`/`setenv`.
- **sys**: compile/load, tracing (`debug`/`trace`/`spy`), `statistics`, `time/1`,
  `time2/1`, `time_out/3`, `garbage_collect`, `halt`/`exit`, `nodebug`.
- **util**: term utils (`vars`, `term_variables`, `copy_term`), string/list utils
  (`split`, `join`, `to_lowercase`, `to_uppercase`, `slice`, `find`), matrix
  utils (`transpose`, …), list/set utils (`permutation`, `combinations`, `sum`,
  `prod`, `avg`, `sort`, `sort_down`, `sort_remove_dups`).
- **ordset**: ordered-set operations.
- **datetime**: date/time values.
- **nn**: FANN neural-network interface (create/train/run/save/load).

## 15. Running programs / interpreter / debugger

- Start: `picat` (REPL, prompt `Picat>`); `help`, `halt`/`exit`, ctrl-d to quit.
- Run a file directly: `picat File Arg1 Arg2 ...` — runs `main/1` if args given,
  else `main/0`. `.pi` extension optional.
- Options: `-d` (debug mode), `-g InitGoal`, `-help`, `-log`,
  `-path "Dir1;Dir2"` (sets PICATPATH), `-s Size` (stack/heap words),
  `-v`/`-version`.
- In the REPL: `cl("file")` compile+load, `compile`, `load`, `cl` (from console).
  Multiple solutions: type `;` after an answer to get the next; `once Goal`
  limits to one. `abort` or ctrl-c to terminate a run.
- Debugger: `debug`/`trace` enter trace mode (recompile to trace), `notrace`/
  `nodebug` leave. Stages: Call, Exit, Redo, Fail. `spy Name/N` sets spy points.

### tbjs sandbox specifics
Picat 3.9 runs via `tbjs:run_js`: bootstrap with
`(0, eval)(await fs.readFile('/opt/languages/bootstrap.js'));` then
`const r = await picat(code, args?)` returning `{stdout, stderr, exitCode}`.
The program needs a `main` predicate; capture printed output from `r.stdout`.
Raise `execution_timeout_secs` to 120+ (wasm startup cost). State never persists
between runs — reload the bootstrap every call.
