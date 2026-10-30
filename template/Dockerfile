# The sandbox image. `npm run template:build` turns this into a template on E2B or Impello.
#
# Keep it small: every tool here is in every thread's sandbox. Claude can `sudo apt-get install`
# anything else it needs during a turn.
#
# Do not add an ENTRYPOINT or EXPOSE. The provider adds its own in-sandbox daemon on top of this.
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep sudo \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y gh \
 && rm -rf /var/lib/apt/lists/*

# --prefix /usr/local so `claude` is on PATH for every user. A plain `npm i -g` can install off
# PATH and still report success.
RUN npm install -g --prefix /usr/local @anthropic-ai/claude-code@latest

# The sandbox runs commands as `user`. Give it a home and passwordless sudo for apt.
RUN (id -u user >/dev/null 2>&1 || useradd -m -s /bin/bash user) \
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \
 && mkdir -p /home/user/.claude /home/user/.agent /home/user/work \
 && chown -R user:user /home/user

WORKDIR /home/user
