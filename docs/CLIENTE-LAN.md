# Usar o OpenDots pelo notebook na rede local

O notebook é um cliente de navegador. Nessa configuração, ele não instala nem inicia o servidor OpenDots e não precisa de Node, Git ou SSH para usar o chat.

```text
Notebook (navegador)
        │ HTTPS + token
PC servidor (OpenDots, histórico SQLite e futuro VoiceStudio)
        │ túnel SSH mantido pelo servidor
BC-250 (Qwen)
```

No PC servidor, o endereço está em `.opendots/lan/url.txt`. Abra esse endereço no navegador do notebook, na mesma rede local.

No primeiro acesso, transfira por um meio confiável o certificado público `.opendots/lan/opendots-local-ca.cer`, confira sua origem e instale-o como autoridade confiável no perfil de usuário do notebook. Abra novamente o endereço e informe o token de `.opendots/lan/owner-token.txt`. Apenas o certificado público e o token precisam chegar ao cliente. A chave privada do certificado e as chaves SSH ficam no servidor.

O servidor deve estar ligado, conectado à BC-250 e com a porta HTTPS permitida apenas na rede privada/local. O script `scripts/allow-lan.ps1`, executado como administrador no servidor, permite a porta 44310 apenas para Node, perfil Private e origem LocalSubnet.

Não execute `setup-lan.ps1` nem `start-local.ps1` no notebook quando ele for apenas cliente: esses scripts preparam outra instalação de servidor. Para hospedar o OpenDots em outro PC, use [o guia de instalação do servidor](LOCAL-HISTORY.md).

As conversas são gravadas no PC servidor, não no clone Git do notebook. Isso não dá acesso a partir de outra rede: acesso externo exigiria uma solução privada própria, fora deste piloto de LAN.
