import { ArchlastForgeProvider, useMutation, usePaginatedQuery, useSession } from "@archlast/forge-react";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Button, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { api, client } from "./src/client";

export default function App() {
  return (
    <SafeAreaProvider>
      <ArchlastForgeProvider client={client}>
        <SafeAreaView style={styles.screen}>
          <StatusBar style="auto" />
          <Home />
        </SafeAreaView>
      </ArchlastForgeProvider>
    </SafeAreaProvider>
  );
}

function Home() {
  const session = useSession();
  if (session.isPending) return <Text style={styles.muted}>Loading…</Text>;
  return session.data ? <Chat name={session.data.user.name} /> : <SignIn />;
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = async (create: boolean) => {
    const r = create
      ? await client.auth.signUp.email({ email, password, name: email.split("@")[0] ?? email })
      : await client.auth.signIn.email({ email, password });
    setError(r.error?.message ?? null);
  };
  return (
    <View style={styles.form}>
      <Text style={styles.title}>Sign in</Text>
      <TextInput style={styles.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
      <TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button title="Sign in" onPress={() => go(false)} />
      <Button title="Create an account" onPress={() => go(true)} />
    </View>
  );
}

/** A live list: a message sent from here, the web or another phone shows up on every screen at once. */
function Chat({ name }: { name: string }) {
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, {}, { initialNumItems: 30 });
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");
  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <Text style={styles.title}>Messages</Text>
        <Button title="Sign out" onPress={() => client.auth.signOut()} />
      </View>
      <FlatList
        inverted
        data={results}
        keyExtractor={(m) => m._id}
        onEndReached={() => status === "CanLoadMore" && loadMore(30)}
        renderItem={({ item }) => (
          <Text style={styles.message}>
            <Text style={styles.author}>{item.authorName}: </Text>
            {item.body}
          </Text>
        )}
      />
      <View style={styles.compose}>
        <TextInput style={[styles.input, styles.grow]} placeholder={`Message as ${name}`} value={body} onChangeText={setBody} />
        <Button title="Send" disabled={!body.trim()} onPress={() => send({ body: body.trim() }).then(() => setBody(""))} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  form: { padding: 24, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 },
  title: { fontSize: 24, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 },
  grow: { flex: 1 },
  compose: { flexDirection: "row", gap: 8, padding: 12 },
  message: { paddingHorizontal: 16, paddingVertical: 6 },
  author: { fontWeight: "600" },
  error: { color: "#c93a05" },
  muted: { padding: 24, color: "#888" },
});
