Pod::Spec.new do |s|
  s.name           = 'SyncedPlayer'
  s.version        = '1.0.0'
  s.summary        = 'AVAudioEngine-based looping player with seamless rate control'
  s.homepage       = 'https://github.com/placeholder'
  s.license        = 'MIT'
  s.author         = 'silentdisco'
  s.platform       = :ios, '15.1'
  s.source         = { git: '' }
  s.source_files   = '**/*.{h,m,mm,swift}'
  s.dependency 'ExpoModulesCore'
end
