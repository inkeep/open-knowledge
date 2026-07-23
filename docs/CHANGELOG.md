# @inkeep/open-knowledge-docs

## 0.0.40

### Patch Changes

- @inkeep/open-knowledge-core@0.38.4

## 0.0.39

### Patch Changes

- @inkeep/open-knowledge-core@0.38.3

## 0.0.38

### Patch Changes

- @inkeep/open-knowledge-core@0.38.2

## 0.0.37

### Patch Changes

- Updated dependencies [1b25773]
  - @inkeep/open-knowledge-core@0.38.1

## 0.0.36

### Patch Changes

- @inkeep/open-knowledge-core@0.38.0

## 0.0.35

### Patch Changes

- @inkeep/open-knowledge-core@0.37.3

## 0.0.34

### Patch Changes

- 86b9804: **Feat:** share links now work with GitHub Enterprise Server remotes
  (PRD-7351). The construct side threads the origin host into the share URL,
  and the receive pipeline carries the host as part of the repo identity end
  to end — so a GHES `owner/repo` share never resolves to a same-named
  github.com clone. Because a decoded deep link is untrusted input, a share
  pointing at a non-github.com host is gated: it proceeds silently only for a
  host the recipient is already authenticated to, otherwise the app prompts to
  open the link in a browser instead. The web splash renders enterprise shares
  with the host shown prominently.
- Updated dependencies [86b9804]
  - @inkeep/open-knowledge-core@0.37.2

## 0.0.33

### Patch Changes

- @inkeep/open-knowledge-core@0.37.1

## 0.0.32

### Patch Changes

- @inkeep/open-knowledge-core@0.37.0

## 0.0.31

### Patch Changes

- @inkeep/open-knowledge-core@0.36.0

## 0.0.30

### Patch Changes

- @inkeep/open-knowledge-core@0.35.6

## 0.0.29

### Patch Changes

- @inkeep/open-knowledge-core@0.35.5

## 0.0.28

### Patch Changes

- @inkeep/open-knowledge-core@0.35.4

## 0.0.27

### Patch Changes

- @inkeep/open-knowledge-core@0.35.3

## 0.0.26

### Patch Changes

- @inkeep/open-knowledge-core@0.35.2

## 0.0.25

### Patch Changes

- @inkeep/open-knowledge-core@0.35.1

## 0.0.24

### Patch Changes

- @inkeep/open-knowledge-core@0.35.0

## 0.0.23

### Patch Changes

- @inkeep/open-knowledge-core@0.34.0

## 0.0.22

### Patch Changes

- @inkeep/open-knowledge-core@0.33.0

## 0.0.21

### Patch Changes

- Updated dependencies [fa17026]
- Updated dependencies [8a93fff]
  - @inkeep/open-knowledge-core@0.32.0

## 0.0.20

### Patch Changes

- @inkeep/open-knowledge-core@0.31.0

## 0.0.19

### Patch Changes

- @inkeep/open-knowledge-core@0.30.1

## 0.0.18

### Patch Changes

- Updated dependencies [9b85ab8]
  - @inkeep/open-knowledge-core@0.30.0

## 0.0.17

### Patch Changes

- @inkeep/open-knowledge-core@0.29.1

## 0.0.16

### Patch Changes

- @inkeep/open-knowledge-core@0.29.0

## 0.0.15

### Patch Changes

- @inkeep/open-knowledge-core@0.28.2

## 0.0.14

### Patch Changes

- @inkeep/open-knowledge-core@0.28.1

## 0.0.13

### Patch Changes

- @inkeep/open-knowledge-core@0.28.0

## 0.0.12

### Patch Changes

- @inkeep/open-knowledge-core@0.27.0

## 0.0.11

### Patch Changes

- @inkeep/open-knowledge-core@0.26.0

## 0.0.10

### Patch Changes

- 19c9928: Fix relative links
- Updated dependencies [d9dc40c]
  - @inkeep/open-knowledge-core@0.25.0

## 0.0.9

### Patch Changes

- @inkeep/open-knowledge-core@0.24.0

## 0.0.8

### Patch Changes

- @inkeep/open-knowledge-core@0.23.0

## 0.0.7

### Patch Changes

- Updated dependencies [372b7b9]
  - @inkeep/open-knowledge-core@0.22.0

## 0.0.6

### Patch Changes

- @inkeep/open-knowledge-core@0.21.0

## 0.0.5

### Patch Changes

- @inkeep/open-knowledge-core@0.20.1

## 0.0.4

### Patch Changes

- Updated dependencies [7ca9e93]
- Updated dependencies [7ca9e93]
- Updated dependencies [7ca9e93]
  - @inkeep/open-knowledge-core@0.20.0

## 0.0.3

### Patch Changes

- Updated dependencies [a349938]
  - @inkeep/open-knowledge-core@0.19.2

## 0.0.2

### Patch Changes

- Updated dependencies [9252046]
- Updated dependencies [c74100b]
- Updated dependencies [e832737]
  - @inkeep/open-knowledge-core@0.19.1
