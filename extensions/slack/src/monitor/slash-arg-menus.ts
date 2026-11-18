import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import { SLACK_MAX_BLOCKS } from "../blocks-input.js";
import { truncateSlackText } from "../truncate.js";
import {
  SLACK_EXTERNAL_ARG_MENU_PREFIX,
  type SlackExternalArgMenuChoice,
} from "./external-arg-menu-store.js";
import { escapeSlackMrkdwn } from "./mrkdwn.js";

export const SLACK_COMMAND_ARG_ACTION_ID = "openclaw_cmdarg";
export const SLACK_COMMAND_ARG_ACTION_LISTENER = /^openclaw_cmdarg/;
const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";
const SLACK_COMMAND_ARG_BUTTON_ROW_SIZE = 5;
const SLACK_COMMAND_ARG_OVERFLOW_MIN = 3;
const SLACK_COMMAND_ARG_OVERFLOW_MAX = 5;
export const SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX = 100;
const SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX = 150;
const SLACK_COMMAND_ARG_BUTTON_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_BUTTON_VALUE_MAX = 2000;
const SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX = 300;
const SLACK_HEADER_TEXT_MAX = 150;
const SLACK_COMMAND_ARG_CHROME_BLOCKS = 3;
const SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX = SLACK_MAX_BLOCKS - SLACK_COMMAND_ARG_CHROME_BLOCKS;

function buildSlackArgMenuConfirm(params: { command: string; arg: string }) {
  const command = escapeSlackMrkdwn(params.command);
  const arg = escapeSlackMrkdwn(params.arg);
  return {
    title: { type: "plain_text", text: "Confirm selection" },
    text: {
      type: "mrkdwn",
      text: truncateSlackText(
        params.command === "controls"
          ? "Open or run the selected control? Clear context starts a fresh session and keeps archived history."
          : `Run */${command}* with *${arg}* set to this value?`,
        SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX,
      ),
    },
    confirm: { type: "plain_text", text: "Run command" },
    deny: { type: "plain_text", text: "Cancel" },
  };
}

function encodeSlackCommandArgValue(parts: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}) {
  return [
    SLACK_COMMAND_ARG_VALUE_PREFIX,
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

export function parseSlackCommandArgValue(raw?: string | null): {
  command: string;
  arg: string;
  value: string;
  userId: string;
} | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split("|");
  if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) {
    return null;
  }
  try {
    const [command, arg, value, userId] = parts.slice(1).map(decodeURIComponent);
    return command && arg && value && userId ? { command, arg, value, userId } : null;
  } catch {
    return null;
  }
}

export function buildSlackArgMenuOptions(choices: SlackExternalArgMenuChoice[]) {
  return choices.map((choice) => ({
    text: {
      type: "plain_text" as const,
      text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX),
    },
    value: choice.value,
  }));
}

export function buildSlackCommandArgMenuBlocks(params: {
  title: string;
  header?: string;
  context?: string;
  preferSelect?: boolean;
  command: string;
  arg: string;
  choices: Array<{ value: string; label: string }>;
  userId: string;
  supportsExternalSelect: boolean;
  createExternalMenuToken: (choices: SlackExternalArgMenuChoice[]) => string;
}) {
  const encodedChoices = params.choices.map((choice) => ({
    label: choice.label,
    value: encodeSlackCommandArgValue({
      command: params.command,
      arg: params.arg,
      value: choice.value,
      userId: params.userId,
    }),
  }));
  const canUseStaticSelect = encodedChoices.every(
    (choice) => choice.value.length <= SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX,
  );
  const canUseOverflow =
    !params.preferSelect &&
    canUseStaticSelect &&
    encodedChoices.length >= SLACK_COMMAND_ARG_OVERFLOW_MIN &&
    encodedChoices.length <= SLACK_COMMAND_ARG_OVERFLOW_MAX;
  const canUseExternalSelect =
    params.supportsExternalSelect &&
    canUseStaticSelect &&
    encodedChoices.length > SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX;
  const confirm = buildSlackArgMenuConfirm({ command: params.command, arg: params.arg });
  const selectElement = { action_id: SLACK_COMMAND_ARG_ACTION_ID, confirm };
  const rows = canUseOverflow
    ? [
        {
          elements: [
            {
              ...selectElement,
              type: "overflow",
              options: buildSlackArgMenuOptions(encodedChoices),
            },
          ],
        },
      ]
    : canUseExternalSelect
      ? [
          {
            block_id: `${SLACK_EXTERNAL_ARG_MENU_PREFIX}${params.createExternalMenuToken(encodedChoices)}`,
            elements: [
              {
                ...selectElement,
                type: "external_select",
                min_query_length: 0,
                placeholder: { type: "plain_text", text: `Search ${params.arg}` },
              },
            ],
          },
        ]
      : (!params.preferSelect && encodedChoices.length <= SLACK_COMMAND_ARG_BUTTON_ROW_SIZE) ||
          !canUseStaticSelect
        ? chunkItems(
            encodedChoices.filter(
              (choice) => choice.value.length <= SLACK_COMMAND_ARG_BUTTON_VALUE_MAX,
            ),
            SLACK_COMMAND_ARG_BUTTON_ROW_SIZE,
          ).map((choices, rowIndex) => ({
            elements: choices.map((choice, colIndex) => ({
              type: "button",
              action_id: `${SLACK_COMMAND_ARG_ACTION_ID}_${rowIndex}_${colIndex}`,
              text: {
                type: "plain_text",
                text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_BUTTON_TEXT_MAX),
              },
              value: choice.value,
              confirm,
            })),
          }))
        : chunkItems(encodedChoices, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map(
            (choices, index) => ({
              elements: [
                {
                  ...selectElement,
                  type: "static_select",
                  placeholder: {
                    type: "plain_text",
                    text:
                      index === 0 ? `Choose ${params.arg}` : `Choose ${params.arg} (${index + 1})`,
                  },
                  options: buildSlackArgMenuOptions(choices),
                },
              ],
            }),
          );
  const headerText = truncateSlackText(
    params.header ?? `/${params.command}: choose ${params.arg}`,
    SLACK_HEADER_TEXT_MAX,
  );
  const sectionText = truncateSlackText(params.title, 3000);
  const contextText = truncateSlackText(
    params.context ?? `Select one option to continue /${params.command} (${params.arg})`,
    3000,
  );
  const visibleRows = rows.slice(0, SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX);
  return [
    {
      type: "header",
      text: { type: "plain_text", text: headerText },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: sectionText },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextText }],
    },
    ...visibleRows.map((row) => Object.assign({ type: "actions" }, row)),
  ];
}
