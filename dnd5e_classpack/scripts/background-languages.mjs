const languages = {
  vedalken: "维多肯语", loxodon: "象族语", kraul: "刻洛语",
  minotaur: "牛头人语", leonin: "狮族语", quori: "梦境语"
};
Hooks.once("init", () => {
  const choices = CONFIG.DND5E.languages.exotic.children;
  for (const [key, label] of Object.entries(languages)) choices[key] ??= label;
});
