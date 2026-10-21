import { Alert, View } from "react-native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { AppText as Text, AppTextInput } from "../../../components/AppText";

/** A labelled single-line field. Secrets pass `secret` so the value is masked and never offered back by the keyboard. */
export function SharedBrowserField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <View className="gap-1 px-4 py-2">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <AppTextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        editable={props.disabled !== true}
        secureTextEntry={props.secret === true}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
      />
    </View>
  );
}

/** Tells the person why a command failed, in the server's own words. */
export function reportCommandFailure(
  title: string,
  result: Parameters<typeof squashAtomCommandFailure>[0],
) {
  Alert.alert(
    title,
    String((squashAtomCommandFailure(result) as { message?: string }).message ?? ""),
  );
}

export function SharedBrowserNote(props: { readonly children: string }) {
  return (
    <Text className="px-4 py-3 text-sm leading-normal text-foreground-muted">{props.children}</Text>
  );
}
