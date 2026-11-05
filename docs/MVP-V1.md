# MVP v1: OpenDots no PC da empresa, Qwen e histórico na BC-250

Distribuição fixa: OpenDots + Claude Code + Codex no PC da empresa. A BC-250 executa apenas o Qwen e o serviço mínimo HTTPS de histórico/proxy. Não há Gemini, voz, sincronização ou outro framework de agentes.

## Dados e autorização

Comece com um projeto novo, exclusivamente sintético. Não importe projetos, conversas, páginas ou bancos corporativos para o piloto. A classificação de um diretório é uma declaração do operador, não uma inspeção automática dos arquivos.

Para dados corporativos, a empresa precisa autorizar expressamente o processamento e armazenamento na BC-250 e o uso dos provedores dos CLIs. Só após essa autorização registre `BC250_DATA_CLASS=corporate`, `BC250_COMPANY_AUTHORIZED=true` e `corporateAuthorized: true` na configuração de projetos. Credenciais de assinatura não equivalem a essa autorização.

O histórico de mensagens, estado e eventos usa um único SQLite na BC-250. Não há cache persistente de conversas, upload do banco anterior ou fallback local. O SQLite original no PC mantém configurações, Spaces/páginas, vínculos das conversas e recibos de aprovação; esses recibos incluem argumentos e resultados de ferramentas. Esses dados locais também devem receber proteção e backup. Esta versão centraliza o histórico, não todo o armazenamento do produto nem os arquivos/sessões próprios dos CLIs.

## Preparar a BC-250

Requer Node 22.13+ com `node:sqlite`, OpenSSL e systemd de usuário. O OpenDots completo continua exigindo Node 24+ no PC. Compile no ambiente de desenvolvimento com `npm ci` e `npm run build`.

Monte uma pasta contendo `deployment/bc250/install.sh` e uma subpasta `code/` com somente `bc-service-main.js`, `bc-service.js` e `local-history.js` de `dist/server/server/`. Transfira apenas esse pacote de código para a BC por um meio administrativo autorizado. Na BC execute:

```sh
BC_LAN_ADDRESS=IP_PRIVADO_DA_BC BC_DNS_NAME=bc250-server.local bash install.sh
```

O instalador cria chaves/token privados, certificado com SAN, banco e `opendots-bc250.service`. Não altera o serviço Qwen existente. O proxy aceita somente `agente` em `/v1/chat/completions`; não publica os controles administrativos da LLM. Só uma instalação OpenDots deve escrever neste histórico/token. Reinicie o serviço após atualizar o código com `systemctl --user restart opendots-bc250`.

Permita TCP 44311 no firewall da BC somente a partir do IP do PC autorizado. Não abra portas no roteador. O instalador não modifica o firewall nem solicita senha administrativa. Para iniciar sem sessão de usuário aberta, o administrador pode habilitar o linger desse usuário. A configuração de firewall/linger depende do administrador da BC.

Entregue ao PC cliente somente o certificado público `private/ca.pem` e o token `private/token`, por canal privado. Não transfira chaves TLS, credenciais SSH, nem autenticações dos CLIs. Token/CA não pertencem ao repositório ou chat público.

## Preparar o PC do OpenDots

1. Copie `deployment/mvp-client.env.example` para `.env`, preencha token/URL e salve a CA em `.opendots/bc250-ca.pem`. Mantenha `LOCAL_ONLY=true`. O Qwen principal fica fixado em `agente` quando `BC250_URL` é usado.
2. Copie `deployment/cli-projects.example.json` para `.opendots/cli-projects.json`. Configure executáveis reais e um diretório de teste sintético. Para o Codex instalado por npm, use `node.exe` e o caminho absoluto de `@openai/codex/bin/codex.js`; não use `.cmd`/`.ps1` ou texto de shell. Execute os CLIs como o mesmo usuário que já fez login por assinatura. Nunca copie arquivos de credenciais de outro PC.
3. Configure um `OWNER_TOKEN` aleatório próprio, mantenha `OWNER_ID` estável e use um banco de workspace novo para o piloto. `pwsh -File scripts/start-mvp.ps1` inicia sem SSH. O launcher antigo `start-local.ps1` continua sendo o fluxo legado com túnel e não deve ser usado neste MVP.
4. Abra a interface no próprio PC. Se acessar de outro dispositivo da LAN, execute `setup-lan.ps1`, configure HTTPS e a origem exata. Não desabilite a validação TLS.

## Delegação e limites

Os CLIs aparecem em Connections dos Dots existentes no início do servidor. O modelo chama `codex__delegate` ou `claude__delegate` com projeto e tarefa; o mecanismo MCP em memória usa as aprovações já existentes. Toda delegação requer aprovação explícita mesmo se alguém desmarcar Ask first. A configuração do proprietário define os diretórios; o modelo não escolhe executáveis, argumentos ou um `cwd` arbitrário. Novos Dots recebem os conectores no próximo início do servidor.

Codex usa `exec --json` com sandbox `read-only` ou `workspace-write`, sem bypass de permissões. Claude usa `-p` com `Read/Glob/Grep` e, se autorizado, `Edit/Write`; comandos Bash não são liberados neste MVP. Portanto, o Claude pode editar arquivos, mas não executar builds/testes pelo conector atual. O Codex pode fazê-los dentro de seu sandbox. O diretório permitido não é, por si só, uma sandbox de sistema operacional do Claude: respeite também as políticas nativas do CLI e só habilite projetos confiáveis.

Não usamos `claude --bare`, pois esse modo ignora a autenticação por assinatura. Hooks/configurações nativas dos CLIs podem ser carregados: revise o projeto e as configurações do usuário antes de autorizá-lo. OpenDots não transfere sua chave BC para os CLIs e não substitui as regras ou limites da assinatura.

Execuções têm limite de 9 minutos por padrão e saída limitada a 2 MiB. O limite MCP acompanha o timeout do CLI. O cartão de aprovação continua mostrando o resultado após recarregar. Não há nova fila, serviço de agentes ou tentativas automáticas de execução. Uma interrupção pode deixar efeitos já concluídos; revise-os antes de autorizar outra tarefa. A indisponibilidade da BC bloqueia novas conversas/execuções, sem criar histórico local alternativo.

## Aceite ponta a ponta

Use somente dados sintéticos. Peça ao Qwen uma tarefa simples no projeto autorizado; confira o cartão, aprove a delegação, verifique um arquivo real produzido pelo CLI e a resposta final baseada no retorno. Repita para Claude e Codex. Reinicie OpenDots e o serviço da BC e confirme as mensagens e os resultados pelo mesmo chat. Verifique também token incorreto, rejeição do cartão e indisponibilidade da BC. Os testes automatizados de transporte/CLI simulado não substituem esse aceite real no PC de destino.

Há um teste de aceite opt-in que cria seu próprio repositório sintético temporário, usa apenas os executáveis configurados e valida os cartões/arquivos/retornos reais. Ele aprova somente as solicitações sintéticas esperadas pelo teste, nunca uma tarefa corporativa:

```powershell
$env:MVP_SYNTHETIC_TEST_APPROVED='true'
node --env-file-if-exists=.env scripts/test-mvp.mjs
# Após reiniciar OpenDots e o serviço de persistência na BC:
node --env-file-if-exists=.env scripts/test-mvp.mjs --verify
```

O teste exige HTTPS direto funcionando; não cria túnel SSH. O recibo fica em `.opendots/mvp-acceptance.json`. `--verify` reabre a camada de histórico usando novas instâncias do OpenDots; o reinício do processo/serviço também deve ser realizado no aceite operacional.

## Estado verificado em 05/11/2026

Testes automatizados de histórico remoto, TLS, aprovação e conectores passaram. Os dois CLIs autenticados criaram arquivos sintéticos reais em um PC de testes autorizado pelo responsável. O serviço mínimo foi instalado na BC, sem dados corporativos, e respondeu localmente por HTTPS com validação de certificado. O aceite completo Qwen → CLI → retorno → histórico remoto ainda depende da liberação administrativa do firewall e da execução do teste no PC de destino. Não declarar o MVP operacional no PC da empresa antes disso.

Ao migrar o piloto para o PC da empresa, reinstale o código e configure as sessões desse PC. O funcionamento num PC de testes não comprova autenticação, firewall, acesso à BC ou políticas corporativas no destino.
