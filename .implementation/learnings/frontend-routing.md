# Frontend routing

- Explorer hash separator is `§` (`#<sid>/explorer/<encPath>§<side>`, percent-encoded by URL bars as `%C2%A7` — parseHash accepts both). Links built with `/<side>` instead (`/head`, `/base`) leak the side into the path: server 400s `bad path: /head`, and `scrollToPath` on the mangled path crashes the tree with `can't access property "endsWith"`.
