# OpenDots com histórico local — piloto

Esta variante usa o código aberto do OpenDots e um executor SSE próprio, com persistência SQLite. Não requer conta, chave, licença nem servidor CopilotKit Intelligence para conversar.

## Onde cada parte roda

| Máquina                | Responsabilidade                                                     |
| ---------------------- | -------------------------------------------------------------------- |
| Notebook na mesma rede | Navegador e interface; não precisa instalar os modelos               |
| PC servidor            | OpenDots, SQLite, permissões, páginas e futuro adaptador VoiceStudio |
| BC-250                 | Qwen, acessado por túnel SSH a partir do PC servidor                 |

Clonar este repositório em outro PC instala o código. Conversas, chaves e certificados não acompanham o clone.

## O que é salvo

`DATABASE_PATH` aponta para `data/opendots.sqlite` por padrão. No mesmo banco ficam as mensagens, respostas, chamadas de ferramentas e seus argumentos/resultados, estado da conversa e eventos de execução. As tabelas adicionais são `local_chat_snapshots`, `local_chat_runs` e `local_chat_events`; páginas e configurações existentes continuam nas tabelas do OpenDots.

O navegador recupera a conversa do servidor ao reconectar. Desconectar não executa novamente ferramentas. Ao reiniciar o servidor, execuções em andamento são marcadas como interrompidas: efeitos já realizados precisam de revisão antes de uma nova tentativa. Não há repetição automática de tarefas interrompidas. O piloto executa um processo servidor por banco; não é uma implementação para múltiplas réplicas.

Histórico antigo armazenado no serviço Intelligence não é baixado nem migrado automaticamente. As conversas locais não são enviadas a ele.

## Instalar em um PC servidor Windows

Requisitos: Node.js 24 ou superior, Git, PowerShell 7 e cliente OpenSSH. O notebook usa apenas um navegador na mesma rede.

1. Clone o repositório privado, entre na pasta e execute `npm ci`.
2. Copie `.env.example` para `.env`. Configure `BC250_SSH_HOST` com o usuário e nome/IP da sua BC-250. Configure uma chave SSH e confira a identidade do servidor antes do primeiro uso. Chaves SSH não pertencem a este repositório.
3. Execute `npm run build`.
4. Execute `pwsh -File scripts/setup-lan.ps1` no PC servidor. O script prepara HTTPS e um token de acesso, sem imprimi-lo. Se necessário, informe `-LanAddress` com o IPv4 privado do PC.
5. Execute `pwsh -File scripts/start-local.ps1`. O túnel escuta apenas em `127.0.0.1:11435`; os dados seguem criptografados até a BC-250. O app e o túnel iniciam em segundo plano, sem janelas de terminal visíveis.
6. Leia o endereço em `.opendots/lan/url.txt`. No notebook, confie na autoridade local de `.opendots/lan/opendots-local-ca.cer`, depois abra esse endereço e informe o token de `.opendots/lan/owner-token.txt`. Transfira esses dois arquivos por um meio confiável; a chave `server.key` fica exclusivamente no servidor. Não ignore alertas de certificado em uso normal.

O script gera uma autoridade local específica para esta instalação e um certificado com o IP/nome do PC. Confira sua impressão digital antes de instalar a autoridade no notebook. Mudanças de IP/nome podem exigir um novo certificado; use uma reserva DHCP para estabilizar o endereço.

Se o firewall impedir o acesso, um administrador pode executar `pwsh -File scripts/allow-lan.ps1` (porta padr�o 44310). A regra permite apenas o Node nessa porta TCP, perfil Private e origem LocalSubnet. Não exponha a aplicação, a BC-250 ou esse túnel à internet. Esta configuração não é multiusuário: o token identifica o único responsável da instalação.

## Configuração e privacidade

```dotenv
CONVERSATION_STORAGE=local
LOCAL_ONLY=true
LOCAL_MODEL_HOSTS=localhost,127.0.0.1,[::1],bc250-server.local
OPENAI_BASE_URL=http://127.0.0.1:11435/v1
OPENAI_API_KEY=local
OPENAI_MODEL=agente
BC250_SSH_HOST=seu-usuario@bc250-server.local
AGENT_RUN_TIMEOUT_MS=600000
WEB_SEARCH_PROVIDER=disabled
COPILOTKIT_TELEMETRY_DISABLED=true
DO_NOT_TRACK=1
```

`LOCAL_ONLY=true` bloqueia modelos fora da lista de hosts autorizados, redirecionamentos da API do modelo, uso de Intelligence, pesquisa web, MCP, Composio, computadores gerenciados e voz em nuvem. Credenciais antigas desses serviços não os ativam nesse modo. A interface mostra `LOCAL · PRIVATE`.

Isso controla as integrações desta aplicação, não oferece anonimato absoluto nem substitui proteção do sistema operacional. O SQLite não é criptografado por esta aplicação: proteja o disco, o usuário do Windows e os backups. Administradores do PC e ferramentas com acesso aos arquivos podem ler os dados. A lista de hosts é configuração confiável do operador; não valida DNS nem transforma qualquer servidor adicionado em serviço seguro.

Claude Code, Codex e Gemini usam serviços externos quando acionados. Não estão conectados neste piloto local. Permitir essas integrações exige uma alteração explícita de configuração e uma política sobre quais dados podem sair; o histórico pode continuar local mesmo nesse caso. O adaptador do VoiceStudio neste PC ainda é uma integração separada a implementar. O modo local não replica Automatic Learning, User Memory gerenciada, analytics ou Channels do Intelligence.

## Backup e transferência

Pare o servidor e o túnel identificados pelos seus arquivos `.pid`, confira os processos correspondentes e copie o banco com o servidor parado. Com o servidor em execução, utilize a API de backup do SQLite; copiar apenas o arquivo principal durante gravações WAL pode perder dados. Restaure também os arquivos locais de configuração por um canal seguro, se necessário. Um clone do Git não é backup das conversas.

Não versionar: `.env`, `data/`, `.opendots/`, bancos SQLite/WAL/SHM, chaves, certificados de uma instalação, logs ou arquivos da empresa. O repositório preserva a licença MIT e a origem CopilotKit/OpenDots. Um fork GitHub de um projeto público também seria público; para alterações privadas, use um repositório privado independente.

## Validação

`npm test` cobre também reabertura real do banco, recuperação sem reexecutar ferramentas, preservação de contexto contra alterações do cliente, chamadas de ferramentas, escopo de conversa/Dot, concorrência, execuções duplicadas e bloqueio de integrações externas. Use também `npm run typecheck`, `npm run lint` e `npm run build`.

O sucesso desses testes é evidência do piloto. Ainda são necessários testes no notebook real, contexto longo, estratégia de backup e revisão de segurança antes de uso com dados sensíveis em produção.

O hist�rico � preservado integralmente; esta fatia ainda n�o implementa or�amento autom�tico de 65K, resumo de conversas longas nem arquivamento por reten��o. Os limites configurados no servidor Qwen continuam valendo. Testes de 16K/32K/65K permanecem pendentes.
