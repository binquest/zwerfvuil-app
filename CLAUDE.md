# Werkafspraken voor Claude

Zie ook `README.md` (project en lokale setup), `docs/STAGING.md` (staging-VM),
`docs/PRE-BETA.md` en `app/AGENTS.md` (Expo).

## Shell

- **Altijd non-interactive.** `npx --yes`, `CI=1`, `DEBIAN_FRONTEND=noninteractive`,
  en flags die vragen overslaan (`-y`, `--yes`, `--force` waar dat veilig is).
  Nooit een commando dat op invoer kan wachten (editor, pager, wachtwoordprompt,
  bevestiging). Pagers uit: `git --no-pager`, `systemctl --no-pager`.
- **Lange commando's** (langer dan ~1 minuut) draaien in de achtergrond met hun
  output naar een logbestand (`*.log` staat in `.gitignore`); check de voortgang
  periodiek in dat logbestand.
- **Lijkt iets te hangen**: check eerst of het op invoer wacht (prompt in de
  output, `ps`, `ss`), voor je het opnieuw probeert of afbreekt.
- **Commando's voor de gebruiker**: Windows PowerShell 5.1. Dus geen `&&` of `||`
  tussen commando's (aparte regels of `;`), geen ternary of `??`, en
  `Copy-Item`/`Remove-Item` in plaats van Unix-commando's. `&&` binnen een string
  die naar de VM gaat (`ssh binquest-staging "a && b"`) mag wel: die string voert
  bash uit.
- Python altijd via de venv: `.venv\Scripts\python` (WSL: `.venv/bin/python`).

## Staging-VM

- Elk commando op de VM: `ssh -o BatchMode=yes binquest-staging 'sudo -n …'`.
  Nooit de Proxmox-host, nooit iets anders op de homeserver (mediastack,
  Pi-hole, Nginx Proxy Manager).
- Alles wat de VM verandert, staat als script of config in `infra/staging/` en
  draait via `.venv\Scripts\python infra\staging\stagingctl.py run vm/<script>.sh`.
  Losse commando's alleen om te lezen of te verifiëren.
- Scripts moeten veilig opnieuw te draaien zijn: eerst de huidige stand
  controleren, alleen veranderen wat afwijkt, en weigeren bij twijfel (bv. een
  schijf die niet leeg is).
- Wijzigingen die SSH kunnen afsluiten (sshd, firewall) gaan met een rollback
  (`arm_rollback` in `vm/lib.sh`, 5 minuten). Pas bevestigen (`<script> confirm`)
  nadat een **nieuwe** SSH-sessie werkt.
- SSH naar de VM kan alleen vanaf het LAN (`LAN_CIDR` in `infra/staging/.env`),
  niet via `tailscale0`. Logins vanaf de pc komen binnen vanaf de router (SNAT van
  de Tailscale subnet router), niet vanaf het IP van de pc.
- Gepubliceerde Docker-poorten altijd op `127.0.0.1`: Docker omzeilt de firewall.
- Secrets alleen op de VM (chmod 600). Nooit in git, in de chat, in logs of in
  procesargumenten die gelogd worden. Scripts op de pc lezen een secret pas
  wanneer ze het nodig hebben, via ssh, en tonen het niet.

## Git en persoonlijke data

- Nooit het e-mailadres, IP-adressen, tailnet-namen of keys van de gebruiker
  committen. Echte waarden alleen in gitignored bestanden (`.env`,
  `app/.env.local`, `supabase/functions/.env`, `infra/staging/.env`); in docs en
  voorbeelden placeholders (`jij@voorbeeld.be`, `<TAILSCALE_IP>`, `<LAN_CIDR>`).
- Voor elke commit: `git status --short` bekijken, alleen bekende bestanden
  stagen (geen blinde `git add -A`) en de staged diff doorzoeken op e-mailadressen,
  IP's en keys.
- Commits met het GitHub-noreply-adres (staat in de lokale git-config).
- Werk op een branch per stap; merge naar `main` pas na akkoord. Geschiedenis
  herschrijven die al gepusht is: eerst vragen.

## Werkwijze

- Communicatie, docs en UI-teksten in het Nederlands; code, comments en
  scriptoutput in het Engels.
- Eén stap of fase tegelijk: bouwen, zelf verifiëren (tests, echte runs),
  committen, kort verslag, en wachten op akkoord.
- Elke keuze die voor de MVP volstaat maar niet voor echte gebruikers, komt in
  `docs/PRE-BETA.md`.
- Context zuinig: verken code met Explore-subagents en lees zelf alleen de
  bestanden die je wijzigt. Test- en build-output nooit volledig in de chat:
  alleen samenvatting en fouten (tail/grep op het logbestand).
- Eén fase per sessie. Boven ±60 % context: commit wat af is, zet een korte
  overdracht in `docs/GAMIFICATION.md` (wat af is, wat nog moet, volgende stap)
  en stop.
