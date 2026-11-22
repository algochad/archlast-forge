import "./global.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { PortalHost } from "@rn-primitives/portal";
import {
  ArchlastForgeProvider,
  useMutation,
  usePaginatedQuery,
  useSession,
} from "@archlast/forge-react";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { api, client } from "./src/client";

export default function App() {
  return (
    <SafeAreaProvider>
      <ArchlastForgeProvider client={client}>
        <SafeAreaView style={{ flex: 1 }}>
          <View className="flex-1 bg-background">
            <StatusBar style="auto" />
            <Home />
          </View>
        </SafeAreaView>
        <PortalHost />
      </ArchlastForgeProvider>
    </SafeAreaProvider>
  );
}

function Home() {
  const session = useSession();
  if (session.isPending)
    return <Text className="p-6 text-muted-foreground">Loading…</Text>;
  return session.data ? <Chat name={session.data.user.name} /> : <SignIn />;
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = async (create: boolean) => {
    const r = create
      ? await client.auth.signUp.email({
          email,
          password,
          name: email.split("@")[0] ?? email,
        })
      : await client.auth.signIn.email({ email, password });
    setError(r.error?.message ?? null);
  };
  return (
    <Card className="m-6">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
      </CardHeader>
      <CardContent className="gap-3">
        <Input
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <Input
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {error && <Text className="text-destructive">{error}</Text>}
        <Button onPress={() => go(false)}>
          <Text>Sign in</Text>
        </Button>
        <Button variant="outline" onPress={() => go(true)}>
          <Text>Create an account</Text>
        </Button>
      </CardContent>
    </Card>
  );
}

/** A live list: a message sent from here, the web or another phone shows up on every screen at once. */
function Chat({ name }: { name: string }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.list,
    {},
    { initialNumItems: 30 },
  );
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");
  return (
    <KeyboardAvoidingView
      className="flex-1"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View className="flex-row items-center justify-between p-4">
        <Text className="text-2xl font-semibold">Messages</Text>
        <Button variant="outline" onPress={() => client.auth.signOut()}>
          <Text>Sign out</Text>
        </Button>
      </View>
      <FlatList
        inverted
        data={results}
        keyExtractor={(m) => m._id}
        onEndReached={() => status === "CanLoadMore" && loadMore(30)}
        renderItem={({ item }) => (
          <Text className="px-4 py-1.5">
            <Text className="font-semibold">{item.authorName}: </Text>
            {item.body}
          </Text>
        )}
      />
      <View className="flex-row gap-2 p-3">
        <Input
          className="flex-1"
          placeholder={`Message as ${name}`}
          value={body}
          onChangeText={setBody}
        />
        <Button
          disabled={!body.trim()}
          onPress={() => send({ body: body.trim() }).then(() => setBody(""))}
        >
          <Text>Send</Text>
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
}
